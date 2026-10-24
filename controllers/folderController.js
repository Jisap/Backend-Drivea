

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
    const [folder] = await sql`
      SELECT * FROM folders                                             -- Seleccionamos todas las columnas de la tabla folders
      WHERE id = ${req.params.id}                                       -- donde el id sea igual al id proporcionado
      AND owner_id = ${req.user.id}                                     -- y que pertenezca al usuario activo
      AND is_trashed = false                                            -- y que no esté en la papelera
    `

    if (!folder) {
      return res.status(404).json({ error: "Folder not found." })
    }

    // Fetch ancestor names in one query (path is UUID[])
    const ancestorIds = folder.path || [];                              // Extrae la ruta del folder (si no tiene ruta, asigna un array vacío)
    const ancestors = ancestorIds.length > 0                            // Si el array de IDs tiene más de 0 elementos, realiza la consulta
      ? await sql`
        SELECT id, name FROM folders                                    -- Seleccionamos el id y el nombre de la tabla folders
        WHERE id = ANY(${ancestorIds}::uuid[])                          -- donde el id sea igual a cualquier elemento del array
    `: []

    // Preserve path order
    const ancestorMap = new Map(ancestors.map((a) => [a.id, a.name]))
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
