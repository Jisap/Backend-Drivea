import { sql } from "../config/db.js";
import path from "path";
import crypto from "crypto";
import { getSignedFileUrl, uploadToStorage } from "../utils/s3Helper.js";
import { adjustUserStorage, cleanupShareLinks } from "../services/storageService.js";

const SORT_MAP = {
  name_asc: "name ASC",
  name_desc: "name DESC",
  size_asc: "size ASC",
  size_desc: "size DESC",
  date_asc: "created_at ASC",
  date_desc: "created_at DESC",
}

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

// ============================================================================
// Obtener archivos de una carpeta o por búsqueda global
// GET /api/files
// Query params: folder / folder_id, search, sort, page, limit
// ============================================================================
export const getFiles = async (req, res) => {
  try {
    // 1. Extraer parámetros de búsqueda, filtrado, orden y paginación desde req.query
    const {
      folder,
      folder_id,
      search,
      sort = "name_asc",
      page = 1,
      limit = 50
    } = req.query;

    // 2. Normalizar la paginación: aseguramos números enteros positivos válidos
    const pageNum = Math.max(1, parseInt(page, 10) || 1);    // Página mínima: 1
    const limitNum = Math.max(1, parseInt(limit, 10) || 50); // Archivos por página (por defecto 50)
    const offset = (pageNum - 1) * limitNum;                 // Cuántos registros saltar en SQL

    // 3. Obtener el criterio de ordenamiento seguro desde el diccionario SORT_MAP
    // Si envían un sort no reconocido, fallback a 'name ASC'
    const orderBy = SORT_MAP[sort] || SORT_MAP.name_asc;

    // 4. Determinar la carpeta objetivo: si es "null", "root" o no viene nada, es la raíz (null)
    const targetFolder = folder_id ?? folder;
    const targetFolderId = !targetFolder || targetFolder === "null" || targetFolder === "root" ? null : targetFolder;

    // 5. Modo de consulta: ¿Búsqueda global o listado dentro de una carpeta?
    // Si viene texto en `search`, buscamos por nombre en cualquier ubicación del usuario
    const isSearch = Boolean(search?.trim());
    const pattern = `%${search?.trim()}%`; // Patrón ILIKE para coincidencia parcial sin distinguir mayúsculas/minúsculas

    // 6. Ejecutar en paralelo: consulta de registros paginados y conteo total de coincidencias
    const [rows, countRows] = await Promise.all([
      // A. Consulta de archivos con ordenamiento y paginación (LIMIT y OFFSET)
      sql`
        SELECT * FROM files
        WHERE owner_id = ${req.user.id} 
          AND is_trashed = false
          AND (
            (${isSearch}::boolean = true AND name ILIKE ${pattern})                             -- Si hay búsqueda, busca por nombre en cualquier carpeta
            OR 
            (${isSearch}::boolean = false AND folder_id IS NOT DISTINCT FROM ${targetFolderId}) -- Si no hay búsqueda, busca en la carpeta especificada
          )
        ORDER BY ${sql.unsafe(orderBy)}
        LIMIT ${limitNum} OFFSET ${offset}
      `,
      // B. Conteo total de archivos para calcular el número total de páginas
      sql`
        SELECT COUNT(*)::int AS total FROM files
        WHERE owner_id = ${req.user.id} 
          AND is_trashed = false
          AND (
            (${isSearch}::boolean = true AND name ILIKE ${pattern})                             -- Si hay búsqueda, cuenta por nombre en cualquier carpeta
            OR 
            (${isSearch}::boolean = false AND folder_id IS NOT DISTINCT FROM ${targetFolderId}) -- Si no hay búsqueda, cuenta en la carpeta especificada
          )
      `
    ]);

    const totalFiles = countRows[0]?.total || 0;

    // 7. Responder con los archivos y la metadata de paginación
    return res.status(200).json({
      files: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalFiles,
        totalPages: Math.ceil(totalFiles / limitNum),
      }
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// ============================================================================
// Obtener URL firmada para previsualización o descarga de un archivo
// GET /api/files/:id/preview
// ============================================================================
export const getFilePreviewUrl = async (req, res) => {
  try {
    // 1. Buscar el archivo en la base de datos
    // Verificamos que el id coincida, que pertenezca al usuario activo
    // y que no esté en la papelera (is_trashed = false)
    const [file] = await sql`
      SELECT * FROM files 
      WHERE id = ${req.params.id} 
        AND owner_id = ${req.user.id}
        AND is_trashed = false
    `;

    // 2. Seguridad: si no existe o no le pertenece al usuario, retornamos 404
    if (!file) {
      return res.status(404).json({ error: "File not found." });
    }

    // 3. Generar la URL prefirmada criptográfica en S3/Neon Storage
    // Usamos el 's3_key' almacenado en BD. La URL tendrá validez temporal
    // permitiendo descargar o previsualizar el archivo sin hacer el bucket público.
    const downloadUrl = await getSignedFileUrl(file.s3_key);

    // 4. Devolvemos la URL generada junto con los datos del archivo
    return res.status(200).json({ url: downloadUrl, file });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// ============================================================================
// Renombrar archivo
// PATCH /api/files/:id/rename
// ============================================================================
export const renameFile = async (req, res) => {
  try {
    const { name } = req.body;

    // 1. Validación básica: evitar nombres vacíos o que solo contengan espacios
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "File name is required and must be a valid string." });
    }

    // 2. Actualizar el nombre en la base de datos
    // - Comprobamos que pertenezca al usuario activo (owner_id = req.user.id)
    // - Que no esté en la papelera (is_trashed = false)
    // - Actualizamos la marca de tiempo 'updated_at' a NOW()
    const [file] = await sql`
      UPDATE files                                          -- Actualizamos la tabla files
      SET name = ${name.trim()}, updated_at = NOW()         -- Establecemos el nuevo nombre y actualizamos la fecha
      WHERE id = ${req.params.id}                           -- Donde el id sea igual al id proporcionado por la URL
        AND owner_id = ${req.user.id}                       -- Y que pertenezca al usuario autenticado
        AND is_trashed = false                              -- Y que no se encuentre en la papelera
      RETURNING *;                                          -- Devolvemos el registro completo actualizado
    `;

    // 3. Si no se encontró el archivo (o no le pertenece al usuario / está en papelera), retornamos 404
    if (!file) {
      return res.status(404).json({ error: "File not found." });
    }

    // 4. Retornamos el objeto del archivo actualizado
    return res.status(200).json({ file });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// ============================================================================
// Mover archivo a otra carpeta (o a la raíz)
// PATCH /api/files/:id/move
// ============================================================================
export const moveFile = async (req, res) => {
  try {
    // 1. Obtener y normalizar el destino solicitado (soporta target_folder y targetFolder)
    const targetFolder = req.body.target_folder ?? req.body.targetFolder;

    // Si viene undefined, null, "null" o "root", significa que se mueve a la raíz ("My Drive", folder_id = null)
    const normalizedTargetFolder = !targetFolder || targetFolder === "null" || targetFolder === "root"
      ? null
      : targetFolder;

    // 2. Si el destino es una carpeta específica, verificar que exista y pertenezca al usuario
    if (normalizedTargetFolder) {
      const [destFolder] = await sql`
        SELECT id FROM folders
        WHERE id = ${normalizedTargetFolder} 
          AND owner_id = ${req.user.id} 
          AND is_trashed = false
      `;

      if (!destFolder) {
        return res.status(404).json({ error: "Destination folder not found." });
      }
    }

    // 3. Actualizar la carpeta padre (folder_id) del archivo
    // - Comprobamos que el archivo pertenezca al usuario autenticado
    // - Y que no esté en la papelera
    const [file] = await sql`
      UPDATE files                                                      -- Actualizamos el registro en la tabla files
      SET folder_id = ${normalizedTargetFolder}, updated_at = NOW()     -- Asignamos la nueva carpeta (o null si es la raíz)
      WHERE id = ${req.params.id}                                       -- Donde el id coincida con el parámetro de la ruta
        AND owner_id = ${req.user.id}                                   -- Y pertenezca al usuario activo
        AND is_trashed = false                                          -- Y no esté en la papelera
      RETURNING *;                                                      -- Devolvemos el registro del archivo actualizado
    `;

    // 4. Si el archivo no existe o no cumple las condiciones de seguridad
    if (!file) {
      return res.status(404).json({ error: "File not found." });
    }

    // 5. Retornamos el archivo con su nueva ubicación
    return res.status(200).json({ file });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// ============================================================================
// Enviar archivo a la papelera (Soft delete)
// DELETE /api/files/:id
// ============================================================================
export const softDeleteFile = async (req, res) => {
  try {
    // 1. Marcar el archivo como enviado a la papelera (is_trashed = true)
    // Registramos la fecha de eliminación (trashed_at) y de actualización (updated_at)
    // Nos aseguramos de que el archivo pertenezca al usuario activo y que aún no esté en papelera
    const [file] = await sql`
      UPDATE files 
      SET is_trashed = true, 
          trashed_at = NOW(), 
          updated_at = NOW()
      WHERE id = ${req.params.id} 
        AND owner_id = ${req.user.id} 
        AND is_trashed = false
      RETURNING *;
    `;

    // 2. Si no se encontró el archivo (o ya estaba en la papelera / no le pertenece)
    if (!file) {
      return res.status(404).json({ error: "File not found." });
    }

    // 3. Revocar/limpiar enlaces públicos compartidos asociados a este archivo
    // Primer argumento: array de IDs de archivos a invalidar ([file.id])
    // Segundo argumento: array de IDs de carpetas (vacío [])
    await cleanupShareLinks([file.id], []);

    // 4. Confirmación de eliminación lógica exitosa
    return res.status(200).json({ message: "File moved to trash." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// Restore file from trash
// POST /api/files/:id/restore
export const restoreFile = async (req, res) => {
  try {
    const [file] = await sql`
      SET is_trashed = false, trashed_at = null, updated_at = NOW()
      WHERE id = ${req.params.id} AND owner_id = ${req.user.id} AND is_trashed = true
      RETURNING id
    `
    if (!file) {
      return res.status(404).json({ error: "File not found in Trash." })
    }

    return res.status(200).json({ message: "File restored from Trash." })

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// Permanently delete file 
// DELETE /api/files/:id/permanent
export const permanentDeleteFile = async (req, res) => {

}

