
import { sql } from "../config/db.js";
import crypto from "crypto";

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

// Get user's share links with single-query resource resolution
// GET /api/shares
export const getUserShareLInks = async (req, res) => {
  try {
    const activeShareLinks = await sql`
      SELECT sl.*,
        CASE 
          WHEN sl.resource_type = "file" THEN json_build_object("id", f.id, "name", f.name, "mime_type", f.mime_type, "size", f.size)
          WHEN sl.resource_type = "folder" THEN json_build_object("id", fo.id, "name", fo.name)
        END AS resource
      FROM share_links sl
      LEFT JOIN files f ON sl.resource_type = "file" 
        AND f.id = sl.resource_id 
        AND f.is_trashed = false
      LEFT JOIN folders pf ON f.folder_id = pf.id
      LEFT JOIN folders fo ON sl.resource_type = "folder"
        AND fo.id = sl.resource_id
        AND fo.is_trashed = false
      WHERE  sl.owner_id = ${req.user.id}
      AND (
        (sl.resource_type = "file" AND f.id IS NOT NULL AND (f.folder_id IS NULL OR pf.is_trashed = false))
        OR 
          (sl.resource_type = "folder" AND fo.id IS NOT NULL)
      )
      ORDER BY sl.created_at DESC
    `;
    return res.status(200).json({ share_links: activeShareLinks });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// Access shared item by token (public link for anyone)
// GET /api/shares/access/:token
export const accessShareLink = async (req, res) => {

}

// Revoke/delete share link
// DELETE /api/shares/:id
export const deleteShareLink = async (req, res) => {

}
