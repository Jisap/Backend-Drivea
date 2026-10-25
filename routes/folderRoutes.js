import express from "express";
import { protect } from "../middleware/auth";
import {
  createFolder,
  getFolders, getFolderDetails,
  trashFolder,
  restoreFolder,
  permanentDeleteFolder,
  renameFolder,
  moveFolder,
  softDeleteFolder
} from "../controllers/folderController";


const folderRouter = express.Router();

folderRouter.use(protect)

folderRouter.post("/", createFolder);
folderRouter.get("/", getFolders);
folderRouter.get("/:id", getFolderDetails);
folderRouter.patch("/:id/rename", renameFolder);
folderRouter.patch("/:id/move", moveFolder);
folderRouter.delete("/:id", softDeleteFolder);
folderRouter.post("/:id/restore", restoreFolder);
folderRouter.delete("/:id/permanent", permanentDeleteFolder);

export default folderRouter;