import { sql } from "../config/db.js";
import { emptyTrashHierarchy } from "../services/storageService.js";

// ============================================================================
// Obtener todos los elementos en la papelera (archivos y carpetas)
// GET /api/trash
// ============================================================================
export const getTrashItems = async (req, res) => {
  try {
    // Consultamos en paralelo tanto los archivos como las carpetas que estén en la papelera
    // - Filtramos por owner_id para que cada usuario solo vea sus propios elementos
    // - Filtramos por is_trashed = true (booleano que indica que están en la papelera)
    // - Ordenamos por trashed_at DESC para mostrar primero lo eliminado más recientemente
    const [files, folders] = await Promise.all([
      // 1. Archivos en papelera
      sql`
        SELECT * FROM files
        WHERE owner_id = ${req.user.id}
          AND is_trashed = true
        ORDER BY trashed_at DESC
      `,
      // 2. Carpetas en papelera
      sql`
        SELECT * FROM folders
        WHERE owner_id = ${req.user.id}
          AND is_trashed = true
        ORDER BY trashed_at DESC
      `
    ]);

    // Devolvemos ambos listados para que el frontend los organice en la vista de papelera
    return res.status(200).json({ files, folders });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// ============================================================================
// Vaciar la papelera del usuario (borrado definitivo total)
// POST /api/trash/empty
// ============================================================================
export const emptyTrash = async (req, res) => {
  try {
    // 1. Delegar el vaciado al servicio centralizado de almacenamiento:
    //    - Elimina todos los objetos físicos de S3/Neon
    //    - Revoca todos los enlaces públicos compartidos
    //    - Borra permanentemente los registros en las tablas 'files' y 'folders'
    //    - Reajusta la cuota de espacio disponible del usuario
    const result = await emptyTrashHierarchy(req.user.id);

    // 2. Responder al cliente con mensaje de éxito y resumen de la operación
    return res.status(200).json({ 
      message: "Trash emptied successfully.",
      ...result // { totalFreedBytes, filesCount, foldersCount }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};