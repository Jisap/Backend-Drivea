import { sql } from "../config/db"



// Get all trashed files and folders for user
// GET /api/trash
export const getTrashItems = async (req, res) => {
  try {
    const [files, folders] = await Promise.all([
      sql`
              SELECT * FROM files
              WHERE owner_id = ${req.user.id}
              AND trashed_at = true
              ORDER BY trashed_at DESC
            `,
      sql`
              SELECT * FROM folders
              WHERE owner_id = ${req.user.id}
              AND trashed_at = true
              ORDER BY trashed_at DESC
            `
    ]);

    return res.status(200).json({ files, folders });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}