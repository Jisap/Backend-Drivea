

// Create new folder
// POST /api/folders
export const createFolder = async (req, res) => {
    try {
        const { name, parent_id } = req.body
    } catch (error) {

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
