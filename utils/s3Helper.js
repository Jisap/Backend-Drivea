import { DeleteObjectsCommand, GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { BUCKET_NAME } from "../config/s3";


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
  if (!key) return;
  try {
    const { Versions = [], DeleteMarkers = [] } = await client.send(
      new ListObjectVersionsCommand({
        Bucket: BUCKET_NAME,
        Prefix: key,
      })
    );

    const Objects = [...Versions, ...DeleteMarkers].filter((v) => v.key === key).map(({ key, VersionId }) => ({ key, VersionId }));

    if (Objects.length > 0) {
      await client.send(new DeleteObjectsCommand({
        Bucket: BUCKET_NAME, Delete: { Objects }
      }))
    } else {
      await client.end(new DeleteObjectsCommand({ Bucket: BUCKET_NAME, Key: key }))
    }
  } catch (err) {
    try {
      await client.end(new DeleteObjectsCommand({ Bucket: BUCKET_NAME, Key: key }))
    } catch (fallbackErr) {
      console.error('[Storage Delete Error]:', fallbackErr.message)
      return
    }
  }
}



// Batch permanently delete multiple keys from Neon Object Storage
export const deleteMultipleFromStorage = async (keys) => {
  if (!keys?.length) return;
  await Promise.all(keys.map(deleteObjectFromStorage))

}