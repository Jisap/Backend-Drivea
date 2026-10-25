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

// Restore a folder and all its contents (recursive subfolders & files)
export const restoreFolderHierarchy = async (folderId, ownerId) => {
  const allFolderIds = await getFolderHierarchyIds(folderId, ownerId);

  await Promise.all([
    sql`
      UPDATE folders
      SET is_trashed = false, trashed_at = null, updated_at = NOW()
      WHERE id = ANY(${allFolderIds}::uuid[])
        AND owner_id = ${ownerId}
    `,
    sql`
      UPDATE files
      SET is_trashed=false, trashed_at=NULL, updated_at=NOW()
      WHERE folder_id = ANY(${allFolderIds}::uuid[])
        AND owner_id = ${ownerId}
    `,
  ])
};
