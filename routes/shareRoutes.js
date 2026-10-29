import express from "express";
import { protect } from "../middleware/auth.js";
import { accessShareLink, deleteShareLink, getUserShareLinks } from "../controllers/shareController.js";

const shareRouter = express.Router();

// Public link access (anyone with the link)
shareRouter.get("/access/:token", accessShareLink)

// Protected share management endpoints
shareRouter.use(protect)

shareRouter.post("/", createShareLink)
shareRouter.get("/", getUserShareLinks)
shareRouter.delete("/:id", deleteShareLink)

export default shareRouter