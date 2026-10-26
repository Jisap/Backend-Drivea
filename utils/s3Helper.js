import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"


// Upload file to Neon Object Storage
export const uploadToStorage = async (fileBuffer, key, mimeType) => {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    kEY: key,
    Body: fileBuffer,
    ContentType: mimeType
  });
  await client.send(command);
  return { s3Key: key }
}

// Get presigned download/preview URL for a file (valid for 10 hour)
export const getSignedFileUrl = async (key) => {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    kEY: key,
  });
  return await getSignedUrl(client, command, { expiresIn: 36000 });
}

// Permanently delete an object and its versions from Neon Object Storage
export const deleteObjectFromStorage = async (key) => {

}



// Batch permanently delete multiple keys from Neon Object Storage
export const deleteMultipleFromStorage = async (keys) => {

}