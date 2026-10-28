import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BUCKET_NAME, client } from "../config/s3.js"; // Importamos el cliente configurado de S3 y el nombre del bucket

// ============================================================================
// 1. Subir archivo a Object Storage (S3 / Neon Storage)
// ============================================================================
// Parámetros:
// - fileBuffer: El contenido binario del archivo en memoria (Buffer)
// - key: La ruta o identificador único con el que se guardará el objeto (ej: "users/123/archivo.pdf")
// - mimeType: El tipo de contenido multimedia (ej: "application/pdf", "image/png")
export const uploadToStorage = async (fileBuffer, key, mimeType) => {
  // 1. Preparamos el comando de subida con los parámetros necesarios
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,    // Nombre del bucket donde se almacenará
    Key: key,               // Identificador único (ruta y nombre del archivo en el bucket)
    Body: fileBuffer,       // Los datos binarios reales del archivo
    ContentType: mimeType   // Permite que el navegador reconozca el tipo de archivo al abrirlo
  });

  // 2. Enviamos el comando a S3 a través del cliente configurado
  await client.send(command);

  // 3. Devolvemos la clave (Key) asignada para guardarla como referencia en la base de datos
  return { s3Key: key };
};

// ============================================================================
// 2. Generar URL firmada temporal de descarga/previsualización
// ============================================================================
// Una "Signed URL" permite acceder de forma segura y temporal a un archivo privado
// sin exponer las credenciales maestras de AWS al frontend ni hacer el bucket público.
export const getSignedFileUrl = async (key) => {
  // 1. Configuramos el comando de lectura indicando qué archivo queremos obtener
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,    // Nombre del bucket
    Key: key,               // Clave del archivo que queremos consultar
  });

  // 2. Generamos una URL prefirmada criptográficamente válida por 10 horas (36000 segundos)
  // Pasado ese tiempo, la URL caduca y ya no permite acceder al archivo.
  return await getSignedUrl(client, command, { expiresIn: 36000 });
};

// ============================================================================
// 3. Eliminar permanentemente un objeto y todas sus versiones
// ============================================================================
// Si el bucket tiene activado el "versionado", un delete normal solo crea un 
// marcador de borrado (DeleteMarker). Esta función busca todas las versiones y marcadores
// para erradicar el archivo por completo y liberar espacio real.
export const deleteObjectFromStorage = async (key) => {
  // Si no se proporcionó ninguna clave, terminamos de inmediato
  if (!key) return;

  try {
    // 1. Consultar todas las versiones y marcadores de borrado existentes para esta clave
    const { Versions = [], DeleteMarkers = [] } = await client.send(
      new ListObjectVersionsCommand({
        Bucket: BUCKET_NAME, // Nombre del bucket
        Prefix: key,         // Filtra los objetos cuyo prefijo coincida con la clave
      })
    );

    // 2. Filtrar coincidencias exactas y mapear a la estructura requerida por S3: [{ Key, VersionId }]
    // (ListObjectVersions puede devolver prefijos similares, por eso se filtra con exactitud)
    const Objects = [...Versions, ...DeleteMarkers]
      .filter((v) => (v.Key ?? v.key) === key)
      .map((v) => ({
        Key: v.Key ?? v.key,
        VersionId: v.VersionId
      }));

    // 3. Si existen versiones o marcadores, los eliminamos todos en lote
    if (Objects.length > 0) {
      await client.send(new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: { Objects } // Array de objetos con su VersionId específico a borrar
      }));
    } else {
      // 4. Si no tiene versiones registradas (ej: versionado desactivado), eliminamos el objeto simple
      await client.send(new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
      }));
    }
  } catch (err) {
    // 5. Estrategia de recuperación (fallback):
    // Si falla listar versiones (por falta de permisos de IAM para ListVersions o bucket sin versionado),
    // intentamos un borrado simple directo
    try {
      await client.send(new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
      }));
    } catch (fallbackErr) {
      // Registramos el error si ambos intentos fallan para no tumbar la aplicación
      console.error('[Storage Delete Error]:', fallbackErr.message);
      throw fallbackErr
    }
  }
};

// ============================================================================
// 4. Eliminar múltiples archivos en paralelo
// ============================================================================
// Útil cuando se borra una carpeta completa o varios archivos a la vez.
// Recibe un array de claves: ['users/1/img.png', 'users/1/doc.pdf', ...]
export const deleteMultipleFromStorage = async (keys) => {
  // Verificamos que keys sea un array y tenga elementos
  if (!keys?.length) return;

  // Ejecutamos la eliminación de cada clave en paralelo aprovechando Promise.all
  await Promise.all(keys.map(deleteObjectFromStorage));
};