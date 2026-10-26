import { sql } from "../config/db.js";
import path from "path";
import crypto from "crypto";
import { uploadToStorage } from "../utils/s3Helper";
import { adjustUserStorage } from "../services/storageService";


// Upload file(s)
// POST /api/files/upload
export const uploadFiles = async (req, res) => {
  try {
    if (!req.files?.length) {
      return res.status(400).json({ error: "No files uploaded." })
    }

    const folderId = req.body.folder_id || req.body.folderId;
    let targetFolderId = null;

    if (folderId && folderId !== "null" && folderId !== "root") {
      const [folder] = await sql`
        SELECT id FROM folders
        WHERE id = ${folderId} 
          AND owner_id = ${req.user.id} 
          AND is_trashed = false
      `;

      if (!folder) {
        return res.status(404).json({ error: "Target folder not found." })
      }
      targetFolderId = folder.id;
    }

    const totalNewBytes = req.files.reduce((acc, f) => acc + f.size, 0);

    if (Number(req.user.storage_used) + totalNewBytes > Number(req.user.storage_limit)) {
      const limitGb = (Number(req.user.storage_limit) / (1024 * 1024 * 1024)).toFixed(1);
      return res.status(403).json({ error: `Upload exceeds storage quota limit of ${limitGb} GB)` })
    }

    // Stream buffers to storage and record in database in parallel
    const createdFiles = await Promise.all(
      req.files.map(async (multerFile) => {
        const fileExt = path.extname(multerFile.originalname);
        const randomString = crypto.randomBytes(8).toString("hex");
        const s3Key = `users/${req.user.id}/${Date.now()}_${randomString}${fileExt}`;

        await uploadToStorage(
          multerFile.buffer,
          s3Key,
          multerFile.mimetype
        );

        const [row] = await sql`
          INSERT INTO files (name, original_name, mime_type, size, s3_key, folder_id, owner_id)
          VALUES (${multerFile.originalname}, ${multerFile.originalname}, ${multerFile.mimetype}, ${multerFile.size}, ${s3Key}, ${targetFolderId}, ${req.user.id})
          RETURNING *;
        `;
        return row;
      })
    );

    const updatedStorage = await adjustUserStorage(req.user.id, totalNewBytes);

    return res.status(201).json({ files: createdFiles, storage: updatedStorage });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// Get files in folder
// GET /api/files
export const getFiles = async (req, res) => {

}

// Get presigned preview/download URL for a file
// GET /api/files/:id/preview
export const getFilePreviewUrl = async (req, res) => {

}

// Rename file
// PATCH /api/files/:id/rename
export const renameFile = async (req, res) => {

}

// Move file to different folder
// PATCH /api/files/:id/move
export const moveFile = async (req, res) => {

}

// Soft delete file 
// DELETE /api/files/:id
export const softDeleteFile = async (req, res) => {

}

// Restore file from trash
// POST /api/files/:id/restore
export const restoreFile = async (req, res) => {

}

// Permanently delete file 
// DELETE /api/files/:id/permanent
export const permanentDeleteFile = async (req, res) => {

}

