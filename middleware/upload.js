import multer from "multer";

const storage = multer.diskStorage()

const maxFileSize = process.env.MAX_FILE_SIZE ? Number(process.env.MAX_FILE_SIZE) : 104857600 // 100MB

export const upload = multer({
    storage,
    limits: { fileSize: maxFileSize }
})