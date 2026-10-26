import { sql } from "../config/db.js";
import path from "path";
import crypto from "crypto";
import { uploadToStorage } from "../utils/s3Helper.js";
import { adjustUserStorage } from "../services/storageService.js";

// ============================================================================
// Subir uno o varios archivos (Upload)
// POST /api/files/upload
// ============================================================================
export const uploadFiles = async (req, res) => {
  try {
    // 1. Verificación inicial de archivos en la petición (inyectados por el middleware Multer)
    if (!req.files?.length) {
      return res.status(400).json({ error: "No files uploaded." });
    }

    // 2. Determinar la carpeta de destino
    // Permite recibir `folder_id` o `folderId` en el cuerpo de la petición
    const folderId = req.body.folder_id || req.body.folderId;
    let targetFolderId = null; // Por defecto es null (se guardará en la raíz "My Drive")

    // Si se especifica una carpeta y no es una referencia a la raíz ("null" o "root")
    if (folderId && folderId !== "null" && folderId !== "root") {
      const [folder] = await sql`
        SELECT id FROM folders
        WHERE id = ${folderId} 
          AND owner_id = ${req.user.id} 
          AND is_trashed = false
      `;

      // Seguridad: verificar que la carpeta pertenezca al usuario y no esté en la papelera
      if (!folder) {
        return res.status(404).json({ error: "Target folder not found." });
      }
      targetFolderId = folder.id;
    }

    // 3. Control de cuota de almacenamiento disponible
    // Sumamos el tamaño en bytes de todos los archivos que se quieren subir
    const totalNewBytes = req.files.reduce((acc, f) => acc + f.size, 0);

    // Verificamos si la suma de lo que ya tiene ocupado + los nuevos archivos supera su límite
    if (Number(req.user.storage_used) + totalNewBytes > Number(req.user.storage_limit)) {
      const limitGb = (Number(req.user.storage_limit) / (1024 * 1024 * 1024)).toFixed(1);
      return res.status(403).json({ error: `Upload exceeds storage quota limit of ${limitGb} GB` });
    }

    // 4. Subida al Object Storage (S3/Neon) e inserción en base de datos en paralelo
    const createdFiles = await Promise.all(
      req.files.map(async (multerFile) => {
        // Extraemos la extensión del archivo original (ej: ".png", ".pdf")
        const fileExt = path.extname(multerFile.originalname);

        // Generamos 8 bytes aleatorios (16 caracteres hexadecimales) para evitar colisiones de nombres en S3
        const randomString = crypto.randomBytes(8).toString("hex");

        // Construimos una ruta única (Key) organizada por usuario:
        // EJEMPLO: "users/uuid-usuario/1715000000000_a1b2c3d4e5f60718.pdf"
        const s3Key = `users/${req.user.id}/${Date.now()}_${randomString}${fileExt}`;

        // A. Subimos el buffer binario del archivo a S3/Neon Storage
        await uploadToStorage(
          multerFile.buffer,
          s3Key,
          multerFile.mimetype
        );

        // B. Registramos la metadata del archivo en la base de datos PostgreSQL
        const [row] = await sql`
          INSERT INTO files (name, original_name, mime_type, size, s3_key, folder_id, owner_id)
          VALUES (
            ${multerFile.originalname}, 
            ${multerFile.originalname}, 
            ${multerFile.mimetype}, 
            ${multerFile.size}, 
            ${s3Key}, 
            ${targetFolderId}, 
            ${req.user.id}
          )
          RETURNING *; -- Devuelve el archivo recién creado en BD
        `;
        return row;
      })
    );

    // 5. Actualizar el contador de bytes consumidos en la cuenta del usuario
    const updatedStorage = await adjustUserStorage(req.user.id, totalNewBytes);

    // 6. Responder con la lista de archivos creados y el nuevo estado del almacenamiento
    return res.status(201).json({ files: createdFiles, storage: updatedStorage });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

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

