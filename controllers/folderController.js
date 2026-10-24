

import { sql } from "../config/db.js";

// Create new folder
// POST /api/folders
export const createFolder = async (req, res) => {
  try {
    // 1. Extraer y normalizar datos del payload
    const { name, parent, parent_id } = req.body;
    const targetParent = parent_id ?? parent; // Permite flexibilidad en el nombre del campo enviado

    // 2. Validación básica: evitar nombres vacíos o solo con espacios
    if (!name.trim()) {
      return res.status(400).json({ error: "Folder name is required." });
    }

    let folderPath = [];

    // 3. Validación de la carpeta padre (si existe)
    if (targetParent) {
      const [parentFolder] = await sql`
        SELECT id, path FROM folders     -- Seleccionamos el id y la ruta del padre [/{id1}/{id2}/...]
        WHERE id = ${targetParent}       -- donde el id del padre debe ser igual al id proporcionado
          AND owner_id = ${req.user.id}  -- y que pertenezca al usuario activo
          AND is_trashed = false         -- y que no esté en la papelera
      `;

      // Seguridad: verifica que el padre exista y pertenezca al usuario activo
      if (!parentFolder) {
        return res.status(404).json({ error: "Parent folder not found" });
      }

      // Construye la ruta materializada: hereda la ruta del padre y añade su ID
      // EJEMPLO DE RUTA:
      // - Si creamos "Proyectos" dentro de "Trabajo" (id: 'uuid-1'):
      //   parentFolder.path = []  --> folderPath resultante = ['uuid-1']
      // - Si creamos "2024" dentro de "Proyectos" (id: 'uuid-2'):
      //   parentFolder.path = ['uuid-1'] --> folderPath resultante = ['uuid-1', 'uuid-2']
      folderPath = [...(parentFolder.path || []), parentFolder.id];
    }

    // 4. Verificación de duplicados en el mismo nivel jerárquico
    const [existing] = await sql`
      SELECT id FROM folders                                              -- Seleccionamos el id de la carpeta 
      WHERE name = ${name.trim()}                                         -- donde el nombre de la carpeta sea igual al nombre proporcionado
        AND parent_id IS NOT DISTINCT FROM ${targetParent || null}        -- y que el padre sea igual al padre proporcionado
        AND owner_id = ${req.user.id}                                     -- y que pertenezca al usuario activo
        AND is_trashed = false                                            -- y que no esté en la papelera
    `;

    // 'IS NOT DISTINCT FROM' maneja de forma segura la comparación cuando targetParent es null (carpeta raíz)
    if (existing) {
      return res.status(400).json({ error: "A Folder with this name already exists here." });
    }

    // 5. Inserción del nuevo registro
    const [folder] = await sql`
      INSERT INTO folders (name, parent_id, owner_id, path)
      VALUES (${name.trim()}, ${targetParent || null}, ${req.user.id}, ${folderPath})
      RETURNING * -- Devuelve el registro completo recién creado
    `;

    return res.status(201).json({ folder });

  } catch (error) {
    // Manejo de errores genérico (en producción, considera loguear el error real y enviar un mensaje genérico al cliente)
    return res.status(500).json({ error: error.message });
  }
};

// Get subfolders in a folder
// GET /api/folders
export const getFolders = async (req, res) => {
  try {
    const parent = req.query.parent_id ?? req.query.parent;           // Asigna parent_id si existe, si no, asigna parent
    const parentId = !parent || parent === "null" ? null : parent;    // Asigna null si parent es null o "null", si no, asigna parent

    const folders = await sql`
      SELECT * FROM folders                                             -- Seleccionamos todas las columnas de la tabla folders
      WHERE owner_id = ${req.user.id}                                   -- donde el dueño sea el usuario activo
      AND parent_id IS NOT DISTINCT FROM ${parentId}                    -- y que el padre sea igual al padre proporcionado
      AND is_trashed = false                                            -- y que no esté en la papelera
      ORDER BY name ASC                                                 -- ordenamos por nombre en orden ascendente
    `
    return res.status(200).json({ folders });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// Get folder details & breadcrumb trail
// GET /api/folders/:id
export const getFolderDetails = async (req, res) => {
  try {
    // 1. Obtener los datos de la carpeta solicitada
    const [folder] = await sql`
      SELECT * FROM folders                                             -- Seleccionamos todas las columnas de la tabla folders
      WHERE id = ${req.params.id}                                       -- donde el id sea igual al id proporcionado
      AND owner_id = ${req.user.id}                                     -- y que pertenezca al usuario activo
      AND is_trashed = false                                            -- y que no esté en la papelera
    `

    if (!folder) {
      return res.status(404).json({ error: "Folder not found." })
    }

    // 2. Obtener los nombres de los ancestros en una sola consulta
    // EJEMPLO: Si la carpeta actual es "2024" (id: 'uuid-3')
    // folder.path en la BD sería: ['uuid-1', 'uuid-2'] 
    const ancestorIds = folder.path || [];                              // Extrae la ruta del folder (si no tiene ruta, asigna un array vacío)
    const ancestors = ancestorIds.length > 0                            // Si el array de IDs tiene más de 0 elementos, realiza la consulta
      ? await sql`
        SELECT id, name FROM folders                                    -- Seleccionamos el id y el nombre de la tabla folders
        WHERE id = ANY(${ancestorIds}::uuid[])                          -- donde el id sea igual a cualquier elemento del array
    `: []

    // 3. Reconstruir el orden jerárquico del breadcrumb (miga de pan)
    // ancestorMap busca en O(1) para no depender del orden desordenado que devuelva SQL
    const ancestorMap = new Map(ancestors.map((a) => [a.id, a.name]))

    // EJEMPLO DE SALIDA FINAL (breadcrumbs):
    // [
    //   { id: null, name: "My Drive" },
    //   { id: 'uuid-1', name: "Trabajo" },      // Extraído de ancestorMap
    //   { id: 'uuid-2', name: "Proyectos" },    // Extraído de ancestorMap
    //   { id: 'uuid-3', name: "2024" }          // La carpeta actual (folder)
    // ]
    const breadcrumbs = [
      { id: null, name: "My Drive" },
      ...ancestorIds.mao((aid) => ({ id: aid, name: ancestorMap.get(aid) ?? "" })),
      { id: folder.id, name: folder.name }
    ]

    return res.status(200).json({ folder, breadcrumbs })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
}

// Rename folder
// PATCH /api/folders/:id/rename
export const renameFolder = async (req, res) => {
  try {
    const { name } = req.body;
    // 1. Validación básica: evitar nombres vacíos o solo con espacios
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: "Folder name is required and must be a valid string." });
    }


    // 2. Obtener el parent_id actual y verificar propiedad/estado
    // Necesitamos el parent_id para asegurar que el nuevo nombre no colisione 
    // con otra carpeta en el mismo directorio.
    const [currentFolder] = await sql`
      SELECT id, parent_id FROM folders 
      WHERE id = ${req.params.id} 
        AND owner_id = ${req.user.id} 
        AND is_trashed = false
    `;

    if (!currentFolder) {
      return res.status(404).json({ error: "Folder not found." });
    }

    // 3. Verificación de duplicados con el NUEVO nombre en el mismo nivel jerárquico
    // EJEMPLO: Si currentFolder.parent_id es NULL (está en la raíz), 
    // buscamos si ya existe otra carpeta en la raíz con el nuevo nombre.
    // Nota: Añadimos "AND id != ${req.params.id}" para no chocar consigo misma.
    const [duplicate] = await sql`
      SELECT id FROM folders 
      WHERE name = ${name.trim()} 
        AND parent_id IS NOT DISTINCT FROM ${currentFolder.parent_id || null}
        AND owner_id = ${req.user.id} 
        AND is_trashed = false 
        AND id != ${req.params.id}
    `;

    if (duplicate) {
      return res.status(400).json({ error: "A folder with this name already exists in this location." });
    }

    // 4. Actualización del registro
    const [folder] = await sql`                             -- Seleccionamos el registro actualizado de la tabla folders
      UPDATE folders                                          -- Actualizamos la tabla folders
        SET name=${name.trim()}, updated_at=NOW()             -- Cambiamos el nombre de la carpeta y la fecha de actualización
        WHERE  id=${req.params.id}                            -- Donde el id sea igual al id proporcionado
          AND owner_id=${req.user.id}                           -- Y que pertenezca al usuario activo
          AND is_trashed=false                                  -- Y que no esté en la papelera
        RETURNING *                                           -- Devolvemos el registro completo actualizado                                                           
    `

    if (!folder) {
      return res.status(404).json({ error: "Folder not found." })
    }
    return res.status(200).json({ folder })
  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
}

// Move folder to another directory
// PATCH /api/folders/:id/move
export const moveFolder = async (req, res) => {

}

// Soft delete folder (move to trash)
// DELETE /api/folders/:id/trash
export const softDeleteFolder = async (req, res) => {

}

// Restore folder from trash
// POST /api/folders/:id/restore
export const restoreFolder = async (req, res) => {

}

// Permanently delete folder and all nested content
// DELETE /api/folders/:id/permanent
export const permanentDeleteFolder = async (req, res) => {

}
