

import { sql } from "../config/db.js";

// Create new folder
// POST /api/folders
export const createFolder = async (req, res) => {
  try {
    const { name, parent, parent_id } = req.body;
    const targetParent = parent_id ?? parent;

    if (!name.trim()) {
      return res.status(400).json({ error: "Folder name is required." })
    }

    let folderPath = [];
    if (targetParent) {
      const [parentFolder] = await sql`
            SELECT id, path FROM folders
            WHERE id = ${targetParent} AND owner_id = ${req.user.id} AND is_trashed = false`

      if (!parentFolder) {
        return res.status(404).json({ error: "Parent folder not found" });
      }

      folderPath = [...(parentFolder.path || []), parentFolder.id];
    }

    // Check duplicate folder in same directory
    const [existing] = await sql`
      SELECT id FROM folders
      WHERE name = ${name.trim()} 
      AND parent_id IS NOT DISTINCT FROM ${targetParent || null}
      AND owner_id = ${req.user.id}
      AND is_trashed = false 
    `
    if (existing) {
      return res.status(400).json({ error: "A Folder with this name already exists here." });
    }

    // Insert new folder
    const [folder] = await sql`
      INSERT INTO folders (name, parent_id, owner_id, path)
      VALUES (${name.trim()}, ${targetParent || null}, ${req.user.id}, ${folderPath})
      RETURNING *
    `

    return res.status(201).json({
      folder
    })

  } catch (error) {
    return res.status(500).json({ error: error.message })
  }
}

// Get subfolders in a folder
// GET /api/folders
export const getFolders = async (req, res) => {

}

// Get folder details & breadcrumb trail
// GET /api/folders/:id
export const getFolderDetails = async (req, res) => {

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
