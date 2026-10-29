
import { sql } from "../config/db.js";
import crypto from "crypto";
import { getSignedFileUrl } from "../utils/s3Helper.js";
import { permission } from "process";

// ============================================================================
// Crear u obtener enlace público compartido (Share Link) para archivo o carpeta
// POST /api/shares
// ============================================================================
export const createShareLink = async (req, res) => {
  try {
    // 1. Extraer y normalizar parámetros del cuerpo de la petición
    const resourceType = req.body.resource_type ?? req.body.resourceType;
    const resourceId = req.body.resource_id ?? req.body.resourceId;
    const { permission = "download", expires_at, expiresAt } = req.body;
    const targetExpiresAt = expires_at ?? expiresAt;

    // 2. Validación de tipo de recurso permitido (solo "file" o "folder")
    if (!["file", "folder"].includes(resourceType)) {
      return res.status(400).json({ error: "Resource type must be 'file' or 'folder'." });
    }

    // 3. Verificar que el recurso exista, no esté en la papelera y pertenezca al usuario autenticado
    const [resource] =
      resourceType === "file"
        ? await sql`
            SELECT id FROM files
            WHERE id = ${resourceId}
              AND owner_id = ${req.user.id}
              AND is_trashed = false
          `
        : await sql`
            SELECT id FROM folders
            WHERE id = ${resourceId}
              AND owner_id = ${req.user.id}
              AND is_trashed = false
          `;

    if (!resource) {
      return res.status(404).json({ error: `${resourceType} not found.` });
    }

    // 4. Comprobar si ya existe un enlace compartido para este recurso y usuario
    const [existing] = await sql`
      SELECT * FROM share_links
      WHERE resource_id = ${resource.id}
        AND owner_id = ${req.user.id}
    `;

    // 5. Manejo de enlace existente:
    // A. Si existe pero ya caducó (fecha actual > fecha de expiración), lo eliminamos para crear uno nuevo
    if (existing && existing.expires_at && new Date() > new Date(existing.expires_at)) {
      await sql`
        DELETE FROM share_links WHERE id = ${existing.id}
      `;
    }
    // B. Si existe y aún es válido, lo reutilizamos para no generar duplicados innecesarios
    else if (existing) {
      return res.status(200).json({ share_link: existing, is_existing: true });
    }

    // 6. Generar un token criptográfico único y aleatorio (32 caracteres hexadecimales)
    // Este token se usará en la URL pública (ej: /api/shares/access/4f8b2c...)
    const token = crypto.randomBytes(16).toString("hex");

    // 7. Insertar el nuevo enlace compartido en la base de datos
    const [share_link] = await sql`
      INSERT INTO share_links (
        token, 
        resource_type, 
        resource_id, 
        owner_id, 
        permission, 
        expires_at
      )
      VALUES (
        ${token}, 
        ${resourceType}, 
        ${resource.id}, 
        ${req.user.id}, 
        ${permission}, 
        ${targetExpiresAt ? new Date(targetExpiresAt) : null}
      )
      RETURNING *;
    `;

    // 8. Responder con el enlace recién creado
    return res.status(201).json({ share_link, is_existing: false });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// ============================================================================
// Obtener todos los enlaces compartidos activos del usuario
// GET /api/shares
// ============================================================================
// Resuelve en UNA SOLA consulta SQL (Single-Query) los enlaces junto con
// la información del recurso compartido (sea archivo o carpeta), omitiendo
// aquellos cuyos recursos hayan sido enviados a la papelera o eliminados.
export const getUserShareLinks = async (req, res) => {
  try {
    const activeShareLinks = await sql`
      SELECT 
        sl.*, -- Todas las columnas de la tabla share_links (id, token, permission, expires_at, etc.)
        
        -- Construcción dinámica de un objeto JSON 'resource' según el tipo de recurso
        CASE 
          -- Si es un archivo: empaqueta id, nombre, mimeType y tamaño en bytes
          WHEN sl.resource_type = 'file' THEN 
            json_build_object(
              'id', f.id, 
              'name', f.name, 
              'mime_type', f.mime_type, 
              'size', f.size
            )
          -- Si es una carpeta: empaqueta id y nombre
          WHEN sl.resource_type = 'folder' THEN 
            json_build_object(
              'id', fo.id, 
              'name', fo.name
            )
        END AS resource

      FROM share_links sl

      -- 1. Unir con la tabla 'files' solo si el enlace es de tipo 'file' y el archivo no está en papelera
      LEFT JOIN files f 
        ON sl.resource_type = 'file' 
       AND f.id = sl.resource_id 
       AND f.is_trashed = false

      -- 2. Unir con la carpeta padre del archivo (pf = parent folder)
      -- Sirve para verificar que la carpeta contenedora tampoco esté en la papelera
      LEFT JOIN folders pf 
        ON f.folder_id = pf.id

      -- 3. Unir con la tabla 'folders' solo si el enlace es de tipo 'folder' y no está en papelera
      LEFT JOIN folders fo 
        ON sl.resource_type = 'folder' 
       AND fo.id = sl.resource_id 
       AND fo.is_trashed = false

      -- Filtros de seguridad e integridad:
      WHERE sl.owner_id = ${req.user.id} -- Solo enlaces del usuario autenticado
        AND (
          -- Condición para archivos:
          -- El archivo debe existir (f.id IS NOT NULL) Y (estar en la raíz O su carpeta padre no estar en papelera)
          (sl.resource_type = 'file' AND f.id IS NOT NULL AND (f.folder_id IS NULL OR pf.is_trashed = false))
          OR 
          -- Condición para carpetas:
          -- La carpeta compartida debe existir y no estar en papelera (fo.id IS NOT NULL)
          (sl.resource_type = 'folder' AND fo.id IS NOT NULL)
        )
      
      ORDER BY sl.created_at DESC; -- Enlaces más recientes primero
    `;

    return res.status(200).json({ share_links: activeShareLinks });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// ============================================================================
// Acceder a un recurso compartido mediante su token público (sin autenticación)
// GET /api/shares/access/:token
// ============================================================================
//           [ Recibe :token por URL ]
//                      │
//           1. Validar Enlace (Token) ──── (¿No existe?) ───► 404 Not Found
//                      │
//           2. Validar Expiración     ──── (¿Caducó?)   ───► 410 Gone
//                      │
//           3. Sumar contador de visitas (+1 access_count)
//                      │
//           4. Obtener datos del dueño (id, name, email)
//                      │
//       ┌──────────────┴──────────────┐
//       ▼                             ▼
//[ CASO A: Archivo ]          [ CASO B: Carpeta ]
//  • ¿Está en papelera?          • ¿Está en papelera?
//  • ¿Su carpeta padre está      • Buscar subcarpetas activas
//    en papelera?                • Buscar archivos directos
//  • Firmar URL S3               • Firmar URL S3 de cada archivo
//  • Responder JSON              • Responder JSON con árbol
export const accessShareLink = async (req, res) => {
  try {
    const { token } = req.params;

    // 1. Buscar el enlace compartido asociado al token
    const [shareLink] = await sql`
      SELECT * FROM share_links WHERE token = ${token}
    `;

    if (!shareLink) {
      return res.status(404).json({ error: "Share link not found or invalid." });
    }

    // 2. Comprobar si el enlace ha expirado (si tiene fecha límite configurada)
    if (shareLink.expires_at && new Date() > new Date(shareLink.expires_at)) {
      return res.status(410).json({ error: "This share link has expired." }); // 410 Gone
    }

    // 3. Registrar analítica: Incrementar el contador de visitas/accesos de forma atómica
    await sql`
      UPDATE share_links 
      SET access_count = access_count + 1 
      WHERE id = ${shareLink.id}
    `;

    // 4. Obtener información básica y pública del propietario para mostrar en la vista
    const [owner] = await sql`
      SELECT id, name, email FROM users WHERE id = ${shareLink.owner_id}
    `;

    // ==========================================================================
    // CASO A: El recurso compartido es un ARCHIVO INDIVIDUAL
    // ==========================================================================
    if (shareLink.resource_type === "file") {
      // A.1. Obtener el archivo y verificar que no esté en la papelera
      const [file] = await sql`
        SELECT * FROM files WHERE id = ${shareLink.resource_id}
      `;
      if (!file || file.is_trashed) {
        return res.status(404).json({ error: "File no longer available" });
      }

      // A.2. Si el archivo está dentro de una carpeta, verificar que la carpeta no esté en papelera
      if (file.folder_id) {
        const [parentFolder] = await sql`
          SELECT is_trashed FROM folders WHERE id = ${file.folder_id}
        `;
        if (!parentFolder || parentFolder.is_trashed) {
          return res.status(404).json({ error: "File is no longer available" });
        }
      }

      // A.3. Generar URL firmada temporal de S3 para descarga/previsualización
      const downloadUrl = await getSignedFileUrl(file.s3_key);

      return res.status(200).json({
        resource_type: "file",
        file,
        url: downloadUrl,
        permission: shareLink.permission,
        owner
      });
    }

    // ==========================================================================
    // CASO B: El recurso compartido es una CARPETA
    // ==========================================================================
    // B.1. Obtener la carpeta y verificar que no esté en la papelera
    const [folder] = await sql`
      SELECT * FROM folders WHERE id = ${shareLink.resource_id}
    `;

    if (!folder || folder.is_trashed) {
      return res.status(404).json({ error: "Folder is no longer available." });
    }

    // B.2. Obtener en paralelo:
    //      - Subcarpetas directas activas (no en papelera)
    //      - Archivos directos activos (no en papelera)
    const [subfolders, files] = await Promise.all([
      sql`
        SELECT id, name, parent_id, created_at FROM folders WHERE parent_id = ${folder.id} AND is_trashed = false
      `,
      sql`
        SELECT * FROM files WHERE folder_id = ${folder.id} AND is_trashed = false
      `
    ]);

    // B.3. Generar URLs firmadas de S3 para cada archivo encontrado en la carpeta
    const filesWithUrls = await Promise.all(
      files.map(async (f) => ({
        ...f,
        url: await getSignedFileUrl(f.s3_key)
      }))
    );

    return res.status(200).json({
      resource_type: "folder",
      folder,
      subfolders,
      files: filesWithUrls,
      permission: shareLink.permission,
      owner
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// ============================================================================
// Revocar / eliminar un enlace compartido
// DELETE /api/shares/:id
// ============================================================================
export const deleteShareLink = async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Eliminar el enlace de la base de datos asegurando que pertenezca al usuario autenticado
    // Se usa 'RETURNING id' para comprobar si realmente se borró un registro
    const [shareLink] = await sql`
      DELETE FROM share_links
      WHERE id = ${id} AND owner_id = ${req.user.id}
      RETURNING id;
    `;

    // 2. Si no retornó ningún id, el enlace no existe o el usuario no es el propietario
    if (!shareLink) {
      return res.status(404).json({ error: "Share link not found or unauthorized." });
    }

    // 3. Confirmar la revocación exitosa
    return res.status(200).json({ message: "Share link revoked successfully." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
