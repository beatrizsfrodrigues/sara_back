const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
require("dotenv").config();
const sharp = require("sharp");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 5001;

app.use(
  cors({
    origin: ["https://sara-portfolio-eta.vercel.app", "http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true,
  })
);
app.use(bodyParser.json());

const credentials = require("./credentials.json");

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});

const drive = google.drive({ version: "v3", auth });

// Helper to convert stream to string
const streamToString = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });

const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 300 }); // cache results for 5 min

app.get("/api/drive/folders/:rootId", async (req, res) => {
  try {
    const rootId = req.params.rootId;
    const cacheKey = `folders-${rootId}`; // Use a more specific cache key

    if (cache.has(cacheKey)) {
      console.log("✅ Serving albums from cache.");
      return res.json(cache.get(cacheKey));
    }

    // 1️⃣ Get the initial list of all album folders
    const response = await drive.files.list({
      q: `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
    });

    const folders = response.data.files || [];

    // ⭐ 2️⃣ Process all folders in parallel instead of one-by-one
    const result = await Promise.all(
      folders.map(async (folder) => {
        let coverImageId = null;

        // A. Look for "cover" subfolder
        const subRes = await drive.files.list({
          q: `'${folder.id}' in parents and name = 'cover' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: "files(id, name)",
          pageSize: 1,
        });
        const coverFolder = subRes.data.files[0];

        // B. If cover folder exists, get the first image inside it
        if (coverFolder) {
          const coverRes = await drive.files.list({
            q: `'${coverFolder.id}' in parents and mimeType contains 'image/' and trashed = false`,
            fields: "files(id)",
            orderBy: "createdTime",
            pageSize: 1,
          });
          if (coverRes.data.files.length > 0) {
            coverImageId = coverRes.data.files[0].id;
          }
        }

        // C. If NO cover image was found, fallback to the first image in the main album folder
        if (!coverImageId) {
          const folderImagesRes = await drive.files.list({
            q: `'${folder.id}' in parents and mimeType contains 'image/' and trashed = false`,
            fields: "files(id)",
            orderBy: "createdTime",
            pageSize: 1,
          });
          coverImageId = folderImagesRes.data.files[0]?.id || null;
        }

        return {
          id: folder.id,
          name: folder.name,
          // ⭐ We now reliably return one ID for the cover image
          coverImageId: coverImageId,
        };
      })
    );

    console.log("✅ Albums fetched and processed in parallel.");
    cache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error("❌ Failed to fetch folders:", error);
    res.status(500).json({ error: "Failed to fetch folders" });
  }
});

// GET password file ID in a folder
app.get("/api/drive/password/:folderId", async (req, res) => {
  try {
    const folderId = req.params.folderId;
    const response = await drive.files.list({
      q: `'${folderId}' in parents and name='password.txt' and trashed=false`,
      fields: "files(id, name)",
      pageSize: 1,
    });
    const file = response.data.files[0];
    if (!file) return res.json({ passwordFileId: null });
    res.json({ passwordFileId: file.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch password" });
  }
});

// GET password content (works for Google Docs or text files)
// GET password content
app.get("/api/drive/password/content/:fileId", async (req, res) => {
  try {
    const fileId = req.params.fileId;

    const response = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    const password = await streamToString(response.data);
    res.send(password.trim());
  } catch (error) {
    console.error("Failed to fetch password content:", error);
    res.status(500).json({ error: "Failed to fetch password content" });
  }
});

// Download file/folder
app.get("/api/download/:id", async (req, res) => {
  const fileId = req.params.id;

  try {
    const meta = await drive.files.get({
      fileId,
      fields: "id, mimeType, name",
    });

    if (meta.data.mimeType === "application/vnd.google-apps.folder") {
      // List files inside the folder (only images)
      const filesResponse = await drive.files.list({
        q: `'${fileId}' in parents and mimeType contains 'image/' and trashed=false`,
        fields: "files(id, name)",
      });

      res.json({ files: filesResponse.data.files || [] });
    } else {
      // Download a normal file
      const file = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "stream" }
      );
      file.data.pipe(res);
    }
  } catch (error) {
    console.error("Failed to download file/folder:", error.errors || error);
    res.status(500).json({ error: "Failed to download file/folder" });
  }
});

app.get("/api/drive/images/:folderId", async (req, res) => {
  try {
    const folderId = req.params.folderId;
    const pageToken = req.query.pageToken || undefined;

    const response = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: "nextPageToken, files(id, name, mimeType, thumbnailLink)",
      orderBy: "createdTime",
      pageSize: 50, // limit to 50 per request
      pageToken,
    });

    // send nextPageToken along with files for client-side pagination
    res.json({
      files: response.data.files || [],
      nextPageToken: response.data.nextPageToken || null,
    });
  } catch (error) {
    console.error("Failed to fetch images:", error);
    res.status(500).json({ error: "Failed to fetch images" });
  }
});

app.post("/download-folder/:id", async (req, res) => {
  const folderId = req.params.id;
  try {
    const filesResponse = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: "files(id, name)",
    });
    res.json({ files: filesResponse.data.files || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to download folder" });
  }
});

// before: app.get("/folder-images/:folderId", async (req, res) => { ... })
app.post("/folder-images/:folderId", async (req, res) => {
  try {
    const folderId = req.params.folderId;
    const { pageToken } = req.body;

    console.log("📩 Received pageToken:", pageToken);

    const response = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields:
        "nextPageToken, files(id, name, mimeType, thumbnailLink, webViewLink, webContentLink)",
      pageSize: 50,
      pageToken: pageToken || undefined,
    });

    res.json(response.data);
  } catch (err) {
    console.error(
      "❌ Google Drive API error:",
      err.response?.data || err.message
    );
    res.status(500).json({ error: err.message });
  }
});

// ⭐ UPDATED THUMBNAIL ROUTE WITH WEBp CONVERSION & CACHING ⭐
// ⭐ UPDATED THUMBNAIL ROUTE WITH WEBp CONVERSION & DYNAMIC RESIZING ⭐
app.get("/thumbnail/:fileId", async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const size = req.query.size ? parseInt(req.query.size) : 600;

    const response = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    response.data
      .pipe(sharp().resize({ width: size }).webp({ quality: 80 }))
      .pipe(res)
      .on("error", (err) => {
        console.error("Sharp processing error:", err);
        res.status(500).send("Failed to process image");
      });
  } catch (err) {
    console.error("Failed to load image:", err);
    res.status(500).send("Failed to load image");
  }
});

// Root route
app.get("/", (req, res) => {
  res.send(
    "Backend funcionando! Use /api/drive/folders/:rootId para acessar pastas."
  );
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

app.get("/health", (req, res) => {
  res.send("OK");
});
