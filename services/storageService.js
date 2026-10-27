import { sql } from "../config/db.js";
import { deleteMultipleFromStorage, deleteObjectFromStorage } from "../utils/s3Helper.js";

/**
 * Obtiene el ID de la carpeta dada y todos los IDs de sus subcarpetas descendientes (a cualquier nivel de profundidad).
 *
 * Explicación del WHERE:
 * - ${folderId} = ANY(path): 'path' es un array nativo de UUIDs (UUID[]) que contiene los IDs de todos los ancestros.
 *   ANY(path) comprueba si folderId está contenido dentro de dicho array (equivalente a path.includes(folderId)).
 *   Si la carpeta A está en el path de la carpeta B, significa que B es descendiente de A.
 *   Ejemplo:
 *     Carpeta A (id: 'uuid-A') -> path: []
 *     Carpeta B (dentro de A) -> path: ['uuid-A']
 *     Carpeta C (dentro de B) -> path: ['uuid-A', 'uuid-B']
 * - Usamos ANY(path) directamente sin '::text[]' para respetar el tipo de dato nativo (UUID[]) definido en la base de datos
 *   y aprovechar los índices o comparaciones de tipos sin conversiones innecesarias.
 */
export const getFolderHierarchyIds = async (folderId, ownerId) => {
  const descendants = await sql`
    SELECT id FROM folders
    WHERE ${folderId} = ANY(path) 
      AND owner_id = ${ownerId}
  `;

  return [folderId, ...descendants.map((f) => f.id)];
};

/**
 * Ajusta el almacenamiento consumido (storage_used) por un usuario sumando o restando bytes.
 *
 * Explicación técnica:
 * - deltaBytes puede ser positivo (subida de archivos) o negativo (eliminación de archivos).
 * - GREATEST(0, storage_used + deltaBytes): Previene que el almacenamiento quede en valores
 *   negativos por posibles desajustes o inconsistencias en la base de datos.
 * - postgres devuelve columnas BIGINT como string en Node.js, por eso convertimos a Number.
 *
 * @param {string} userId - ID del usuario
 * @param {number} deltaBytes - Cantidad de bytes a sumar (+) o restar (-)
 * @returns {Promise<number|null>} El nuevo almacenamiento consumido en bytes
 */
export const adjustUserStorage = async (userId, deltaBytes) => {
  const [user] = await sql`
    UPDATE users
    SET storage_used = GREATEST(0, storage_used + ${deltaBytes}),
        updated_at = NOW() 
    WHERE id = ${userId} 
    RETURNING storage_used
  `;

  return user ? Number(user.storage_used) : null;
};

/**
 * Elimina los enlaces públicos/compartidos (share_links) vinculados a una lista de archivos o carpetas.
 *
 * ¿Por qué es necesario?:
 * Si un archivo o carpeta se envía a la papelera o se elimina, los enlaces compartidos
 * existentes deben quedar revocados inmediatamente por seguridad.
 *
 * @param {string[]} fileIds - Array de IDs de archivos afectados
 * @param {string[]} folderIds - Array de IDs de carpetas afectadas
 */
export const cleanupShareLinks = async (fileIds = [], folderIds = []) => {
  if (fileIds.length === 0 && folderIds.length === 0) return;

  const allIds = [...fileIds, ...folderIds];
  await sql`
    DELETE FROM share_links 
    WHERE resource_id = ANY(${allIds}::uuid[])
  `;
};

/**
 * Realiza un borrado lógico (soft delete) en cascada de una carpeta y todo su contenido.
 *
 * Flujo:
 * 1. Obtiene la jerarquía completa (la carpeta objetivo + todas las subcarpetas descendientes).
 * 2. Busca todos los archivos activos que residan en cualquiera de esas carpetas.
 * 3. Ejecuta en paralelo con Promise.all:
 *    - Marcar todas las carpetas como is_trashed = true con la misma marca de tiempo (trashed_at).
 *    - Marcar todos los archivos como is_trashed = true con la misma marca de tiempo (trashed_at).
 *    - Revocar los share_links de todos los archivos y carpetas afectados.
 *
 * @param {string} folderId - ID de la carpeta raíz a enviar a la papelera
 * @param {string} ownerId - ID del usuario dueño de los recursos
 */
export const softDeleteFolderHierarchy = async (folderId, ownerId) => {
  // 1. Obtener todos los IDs de las carpetas involucradas (padre + descendientes)
  const allFolderIds = await getFolderHierarchyIds(folderId, ownerId);
  const now = new Date();

  // 2. Obtener los IDs de todos los archivos activos dentro de esas carpetas
  const files = await sql`
    SELECT id FROM files
    WHERE folder_id = ANY(${allFolderIds}::uuid[])
      AND owner_id = ${ownerId}
      AND is_trashed = false
  `;

  const fileIds = files.map((f) => f.id);

  // 3. Actualizar carpetas, archivos y revocar enlaces compartidos en paralelo
  await Promise.all([
    // Marcar como enviadas a papelera todas las carpetas de la jerarquía
    sql`
      UPDATE folders
      SET is_trashed = true, trashed_at = ${now}, updated_at = NOW()
      WHERE id = ANY(${allFolderIds}::uuid[]) 
        AND owner_id = ${ownerId}
    `,

    // Marcar como enviados a papelera todos los archivos asociados (si hay alguno)
    fileIds.length > 0
      ? sql`
        UPDATE files
        SET is_trashed = true, trashed_at = ${now}, updated_at = NOW()
        WHERE id = ANY(${fileIds}::uuid[]) 
          AND owner_id = ${ownerId}
      `
      : Promise.resolve(),

    // Eliminar enlaces compartidos de todos los recursos afectados
    cleanupShareLinks(fileIds, allFolderIds),
  ]);
};

/**
 * Restaura una carpeta y todo su contenido (subcarpetas y archivos) desde la papelera.
 *
 * Flujo:
 * 1. Obtiene la información de la carpeta raíz a restaurar.
 * 2. Comprueba el estado de su carpeta padre (parent_id):
 *    - Si el padre no existe o sigue en la papelera, reubica esta carpeta en la raíz (parent_id = NULL, path = '{}')
 *      y recalcula las rutas (path) de todos sus descendientes para evitar carpetas huérfanas.
 *    - Si el padre sigue activo, preserva la estructura de rutas intacta.
 * 3. Reestablece 'is_trashed = false' y limpia 'trashed_at' tanto en la jerarquía de carpetas como en todos sus archivos.
 *
 * @param {string} folderId - ID de la carpeta raíz a restaurar
 * @param {string} ownerId - ID del usuario propietario
 */
export const restoreFolderHierarchy = async (folderId, ownerId) => {
  // 1. Obtener los datos de la carpeta que se va a restaurar
  const [targetFolder] = await sql`
    SELECT id, parent_id, path FROM folders
    WHERE id = ${folderId} AND owner_id = ${ownerId}
  `;

  if (!targetFolder) return;

  // 2. Verificar si el padre sigue existiendo y está activo (no en papelera)
  let shouldMoveToRoot = false;
  if (targetFolder.parent_id) {
    const [parent] = await sql`
      SELECT id, is_trashed FROM folders
      WHERE id = ${targetFolder.parent_id} AND owner_id = ${ownerId}
    `;

    // Si el padre no existe o sigue en la papelera, movemos esta carpeta a la raíz
    if (!parent || parent.is_trashed) {
      shouldMoveToRoot = true;
    }
  }

  // 3. Obtener todos los IDs de la jerarquía (folderId + subcarpetas)
  const allFolderIds = await getFolderHierarchyIds(folderId, ownerId);

  // 4. Si el padre estaba en la papelera, reubicar a la raíz y actualizar las rutas de descendientes
  if (shouldMoveToRoot) {
    // Actualizar la carpeta principal a la raíz
    await sql`
      UPDATE folders
      SET parent_id = NULL,
          path = '{}',
          is_trashed = false,
          trashed_at = NULL,
          updated_at = NOW()
      WHERE id = ${folderId} AND owner_id = ${ownerId}
    `;

    // Actualizar los descendientes: remover los ancestros que estaban por encima de esta carpeta
    const descendants = await sql`
      SELECT id, path FROM folders
      WHERE ${folderId} = ANY(path) AND owner_id = ${ownerId}
    `;

    if (descendants.length > 0) {
      await Promise.all(
        descendants.map((desc) => {
          // El nuevo path conserva solo a partir de folderId hacia abajo
          const folderIdx = desc.path.findIndex((p) => p === folderId);
          const newDescPath = folderIdx !== -1 ? desc.path.slice(folderIdx) : [folderId];

          return sql`
            UPDATE folders
            SET path = ${newDescPath},
                is_trashed = false,
                trashed_at = NULL,
                updated_at = NOW()
            WHERE id = ${desc.id}
          `;
        })
      );
    }
  } else {
    // Si el padre está activo, simplemente restaurar todas las carpetas conservando sus rutas
    await sql`
      UPDATE folders
      SET is_trashed = false, trashed_at = NULL, updated_at = NOW()
      WHERE id = ANY(${allFolderIds}::uuid[]) AND owner_id = ${ownerId}
    `;
  }

  // 5. Restaurar todos los archivos que pertenecen a estas carpetas
  await sql`
    UPDATE files
    SET is_trashed = false, trashed_at = NULL, updated_at = NOW()
    WHERE folder_id = ANY(${allFolderIds}::uuid[]) AND owner_id = ${ownerId}
  `;
};

/**
 * Elimina definitivamente y de forma irreversible una carpeta y todo su contenido.
 *
 * Flujo:
 * 1. Obtiene la lista completa de carpetas (la principal + todas las subcarpetas descendientes).
 * 2. Consulta los archivos almacenados en esas carpetas (IDs, s3_keys y tamaños).
 * 3. Ejecuta en paralelo:
 *    - Borrado físico de los objetos en S3 / Neon Storage.
 *    - Revocación y borrado de share_links de carpetas y archivos.
 *    - Borrado de registros en la tabla 'files'.
 *    - Borrado de registros en la tabla 'folders'.
 * 4. Si se borraron archivos, decrementa el espacio consumido (storage_used) del usuario.
 *
 * @param {string} folderId - ID de la carpeta a eliminar definitivamente
 * @param {string} ownerId - ID del usuario dueño
 * @returns {Promise<{ totalFreedSize: number }>} Total de bytes liberados
 */
export const permanentDeleteFolderHierarchy = async (folderId, ownerId) => {
  const allFolderIds = await getFolderHierarchyIds(folderId, ownerId);

  const files = await sql`
    SELECT id, s3_key, size FROM files
    WHERE folder_id = ANY(${allFolderIds}::uuid[]) 
      AND owner_id = ${ownerId}
  `;

  const s3Keys = files.map((f) => f.s3_key);
  const fileIds = files.map((f) => f.id);
  const totalFreedSize = files.reduce((acc, f) => acc + Number(f.size), 0);

  // Ejecución concurrente del borrado en almacenamiento externo y base de datos
  await Promise.all([
    s3Keys.length > 0 ? deleteMultipleFromStorage(s3Keys) : Promise.resolve(),
    cleanupShareLinks(fileIds, allFolderIds),
    fileIds.length > 0
      ? sql`DELETE FROM files WHERE id = ANY(${fileIds}::uuid[])`
      : Promise.resolve(),
    sql`DELETE FROM folders WHERE id = ANY(${allFolderIds}::uuid[])`,
  ]);

  // Si había archivos, descontar el espacio del almacenamiento del usuario
  if (totalFreedSize > 0) {
    await adjustUserStorage(ownerId, -totalFreedSize);
  }

  return {
    totalFreedSize,
  };
};

// ============================================================================
// Eliminar permanentemente un archivo individual y liberar espacio
// ============================================================================
// Parámetros:
// - file: Objeto completo del archivo obtenido de la BD (debe contener id, s3_key, size)
// - ownerId: UUID del usuario propietario para actualizar su cuota
export const permanentDeleteFileRecord = async (file, ownerId) => {
  // 1. Ejecutar de forma simultánea (concurrente) las 3 tareas de eliminación:
  //    A. Borrar el objeto físico y sus versiones de S3/Neon Storage (deleteObjectFromStorage)
  //    B. Invalidar/eliminar enlaces públicos compartidos del archivo (cleanupShareLinks)
  //    C. Borrar el registro definitivo del archivo en la tabla PostgreSQL (DELETE FROM files)
  await Promise.all([
    deleteObjectFromStorage(file.s3_key),
    cleanupShareLinks([file.id], []),
    sql`DELETE FROM files WHERE id = ${file.id}`
  ]);

  // 2. Liberar el espacio en la cuota del usuario:
  // Restamos los bytes del archivo (usando valor negativo) a storage_used
  if (Number(file.size) > 0) {
    await adjustUserStorage(ownerId, -Number(file.size));
  }
};

