/**
 * URL代理上传API - 独立实现
 * 解决前端直接fetch外部URL时的CORS限制问题
 * 支持多种文件格式：图片、视频、音频、文档等
 *
 * POST /api/upload-from-url
 * Body: { url: string, storageMode?: string }
 */

// 允许的最大文件大小（20MB，与Telegram限制一致）
import {
  buildTelegramDirectLink,
  buildTelegramBotApiUrl,
  createSignedTelegramFileId,
  getTelegramUploadMethodAndField,
  pickTelegramFileId,
  sendTelegramUploadNotice,
  shouldUseSignedTelegramLinks,
  shouldWriteTelegramMetadata,
} from "../utils/telegram.js";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
// 请求超时时间（30秒）
const FETCH_TIMEOUT = 30000;

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 解析请求体
    const body = await request.json();
    const { url, storageMode = "telegram" } = body;

    // 验证URL
    if (!url || typeof url !== "string") {
      return jsonResponse({ error: "请提供有效的URL" }, 400);
    }

    // URL格式验证
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return jsonResponse({ error: "仅支持HTTP/HTTPS协议的URL" }, 400);
      }
    } catch {
      return jsonResponse({ error: "URL格式无效" }, 400);
    }

    // 从URL获取文件
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    let fetchResponse;
    try {
      fetchResponse = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "image/*,video/*,audio/*,application/*,*/*",
        },
      });
    } catch (error) {
      if (error.name === "AbortError") {
        return jsonResponse({ error: "请求超时，目标服务器响应过慢" }, 408);
      }
      return jsonResponse({ error: "无法连接到目标URL: " + error.message }, 502);
    } finally {
      clearTimeout(timeout);
    }

    if (!fetchResponse.ok) {
      return jsonResponse({ error: `目标URL返回错误: ${fetchResponse.status} ${fetchResponse.statusText}` }, 502);
    }

    // 获取内容类型
    const contentType = fetchResponse.headers.get("content-type") || "application/octet-stream";

    // 获取文件内容
    const arrayBuffer = await fetchResponse.arrayBuffer();
    const fileSize = arrayBuffer.byteLength;

    // 检查文件大小
    if (fileSize === 0) {
      return jsonResponse({ error: "目标URL返回的内容为空" }, 400);
    }

    if (fileSize > MAX_FILE_SIZE) {
      return jsonResponse({ error: `文件大小(${formatSize(fileSize)})超过限制(${formatSize(MAX_FILE_SIZE)})` }, 413);
    }

    // 从URL路径提取文件名
    let fileName = parsedUrl.pathname.split("/").pop() || "";
    fileName = decodeURIComponent(fileName.split("?")[0]);

    if (!fileName || fileName === "") {
      const ext = getExtensionFromMimeType(contentType);
      fileName = `url_${Date.now()}.${ext}`;
    }

    if (!fileName.includes(".")) {
      const ext = getExtensionFromMimeType(contentType);
      fileName = `${fileName}.${ext}`;
    }

    const fileExtension = fileName.split(".").pop().toLowerCase();

    // 根据存储模式上传
    if (storageMode === "r2") {
      if (!env.R2_BUCKET) {
        return jsonResponse({ error: "R2 未配置或未启用" }, 400);
      }
      return await uploadToR2(arrayBuffer, fileName, fileExtension, contentType, fileSize, env);
    } else {
      // 默认上传到 Telegram
      return await uploadToTelegram(
        arrayBuffer,
        fileName,
        fileExtension,
        contentType,
        fileSize,
        env,
        new URL(request.url).origin
      );
    }
  } catch (error) {
    console.error("URL upload error:", error);
    return jsonResponse({ error: "服务器内部错误: " + error.message }, 500);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function getExtensionFromMimeType(mimeType) {
  const type = (mimeType || "").split(";")[0].trim().toLowerCase();
  const mimeMap = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/x-icon": "ico",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-msvideo": "avi",
    "video/x-matroska": "mkv",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/x-m4a": "m4a",
    "audio/mp4": "m4a",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/x-rar-compressed": "rar",
    "application/x-7z-compressed": "7z",
    "text/plain": "txt",
    "text/html": "html",
    "text/css": "css",
    "text/javascript": "js",
    "application/json": "json",
  };
  return mimeMap[type] || "bin";
}

// --- Telegram 上传 ---
async function uploadToTelegram(
  arrayBuffer,
  fileName,
  fileExtension,
  contentType,
  fileSize,
  env,
  fallbackOrigin = ""
) {
  // 从 arrayBuffer 创建 Blob 和 File
  const blob = new Blob([arrayBuffer], { type: contentType });
  const file = new File([blob], fileName, { type: contentType });

  const formData = new FormData();
  formData.append("chat_id", env.TG_Chat_ID);

  const { method: apiEndpoint, field } = getTelegramUploadMethodAndField(contentType);
  formData.append(field, file);

  const apiUrl = buildTelegramBotApiUrl(env, apiEndpoint);

  let response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      body: formData,
    });
  } catch (error) {
    return jsonResponse({ error: "Telegram API 请求失败: " + error.message }, 502);
  }

  const responseData = await response.json();

  if (!response.ok) {
    // 如果图片/音频上传失败，尝试作为文档上传
    if (apiEndpoint === "sendPhoto" || apiEndpoint === "sendAudio") {
      const docFormData = new FormData();
      docFormData.append("chat_id", env.TG_Chat_ID);
      docFormData.append("document", file);
      
      const docResponse = await fetch(buildTelegramBotApiUrl(env, "sendDocument"), {
        method: "POST",
        body: docFormData,
      });
      
      const docData = await docResponse.json();
      if (docResponse.ok) {
        return await processTelegramSuccess(
          docData,
          fileName,
          fileExtension,
          contentType,
          fileSize,
          env,
          fallbackOrigin
        );
      }
    }
    return jsonResponse({ error: responseData.description || "Telegram 上传失败" }, 500);
  }

  return await processTelegramSuccess(
    responseData,
    fileName,
    fileExtension,
    contentType,
    fileSize,
    env,
    fallbackOrigin
  );
}

async function processTelegramSuccess(
  responseData,
  fileName,
  fileExtension,
  mimeType,
  fileSize,
  env,
  fallbackOrigin = ""
) {
  const fileId = pickTelegramFileId(responseData);
  const messageId = responseData?.result?.message_id;

  if (!fileId) {
    return jsonResponse({ error: "无法获取文件ID" }, 500);
  }

  const directId = await buildTelegramDirectId(
    fileId,
    fileExtension,
    fileName,
    mimeType,
    fileSize,
    messageId,
    env
  );

  // 保存到 KV
  if (env.img_url && shouldWriteTelegramMetadata(env)) {
    await env.img_url.put(`${fileId}.${fileExtension}`, "", {
      metadata: {
        TimeStamp: Date.now(),
        ListType: "None",
        Label: "None",
        liked: false,
        fileName: fileName,
        fileSize: fileSize,
        storageType: "telegram",
        telegramFileId: fileId,
        telegramMessageId: messageId || undefined,
        signedLink: shouldUseSignedTelegramLinks(env),
      },
    });
  }

  const directLink = buildTelegramDirectLink(env, directId, fallbackOrigin);
  try {
    const noticeResult = await sendTelegramUploadNotice(
      {
        chatId: env.TG_Chat_ID,
        replyToMessageId: messageId || undefined,
        directLink,
        fileId,
        messageId,
        fileName,
        fileSize,
      },
      env
    );
    if (!noticeResult?.ok && !noticeResult?.skipped) {
      console.warn(
        "Telegram upload notice failed:",
        noticeResult?.data?.description || noticeResult?.error || "unknown error"
      );
    }
  } catch (error) {
    console.warn("Telegram upload notice error:", error.message);
  }

  return jsonResponse([{ src: `/file/${directId}` }]);
}

// --- R2 上传 ---
async function uploadToR2(arrayBuffer, fileName, fileExtension, contentType, fileSize, env) {
  try {
    const fileId = `r2_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const objectKey = `${fileId}.${fileExtension}`;

    await env.R2_BUCKET.put(objectKey, arrayBuffer, {
      httpMetadata: { contentType },
      customMetadata: { fileName, uploadTime: Date.now().toString() },
    });

    if (env.img_url) {
      await env.img_url.put(`r2:${objectKey}`, "", {
        metadata: {
          TimeStamp: Date.now(),
          ListType: "None",
          Label: "None",
          liked: false,
          fileName,
          fileSize,
          storageType: "r2",
          r2Key: objectKey,
        },
      });
    }

    return jsonResponse([{ src: `/file/r2:${objectKey}` }]);
  } catch (error) {
    console.error("R2 upload error:", error);
    return jsonResponse({ error: "R2 上传失败: " + error.message }, 500);
  }
}

async function buildTelegramDirectId(
  fileId,
  fileExtension,
  fileName,
  mimeType,
  fileSize,
  messageId,
  env
) {
  if (!shouldUseSignedTelegramLinks(env)) {
    return `${fileId}.${fileExtension}`;
  }
  return await createSignedTelegramFileId(
    {
      fileId,
      fileExtension,
      fileName,
      mimeType,
      fileSize,
      messageId,
    },
    env
  );
}
