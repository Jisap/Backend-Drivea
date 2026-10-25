import { sql } from "../config/db.js";

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
 * 1. Obtiene toda la jerarquía de IDs (la carpeta seleccionada + todas sus subcarpetas).
 * 2. Ejecuta concurrentemente en Promise.all:
 *    - Reestablece 'is_trashed = false' y limpia 'trashed_at' para todas las carpetas del árbol.
 *    - Reestablece 'is_trashed = false' y limpia 'trashed_at' para todos los archivos dentro de esas carpetas.
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


