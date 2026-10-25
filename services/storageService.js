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


export const softDeleteFolderHierarchy = async (folderId, ownerId) => {

}


