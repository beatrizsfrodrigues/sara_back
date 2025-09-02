const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5001;

app.use(
  cors({
    origin: "https://sara-portfolio-eta.vercel.app", // <-- replace with your React app URL
    methods: ["GET", "POST"],
    credentials: true,
  })
);
app.use(bodyParser.json());

const credentials = JSON.parse(
  process.env.GOOGLE_CREDENTIALS.replace(/\\n/g, "\n")
);

// Google Drive API setup
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

// GET all folders inside a root folder
app.get("/api/drive/folders/:rootId", async (req, res) => {
  try {
    const rootId = req.params.rootId;
    const response = await drive.files.list({
      q: `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
    });

    const folders = response.data.files || [];

    // Add first image thumbnail for each folder
    const foldersWithImages = await Promise.all(
      folders.map(async (folder) => {
        const files = await drive.files.list({
          q: `'${folder.id}' in parents and mimeType contains 'image/' and trashed = false`,
          fields: "files(id, name)",
          orderBy: "createdTime",
          pageSize: 1,
        });

        const firstImage = files.data.files[0];
        return {
          id: folder.id,
          name: folder.name,
          firstImageId: firstImage ? firstImage.id : null,
        };
      })
    );

    res.json(foldersWithImages);
  } catch (error) {
    console.error(error);
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

// GET thumbnail by fileId
app.get("/api/thumbnail/:fileId", async (req, res) => {
  const fileId = req.params.fileId;

  try {
    const fileMeta = await drive.files.get({
      fileId,
      fields: "id, name, mimeType",
    });

    const mimeType = fileMeta.data.mimeType;
    res.setHeader("Content-Type", mimeType);

    const file = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    file.data.pipe(res);
  } catch (err) {
    console.error("Failed to fetch thumbnail:", err);
    res.status(500).send("Failed to load image");
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
    const response = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: "files(id, name, mimeType, thumbnailLink)", // <-- Add thumbnailLink here
      orderBy: "createdTime",
    });
    res.json(response.data.files || []);
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
    const { pageToken } = req.body; // ✅ read from body instead of query

    console.log("📩 Received pageToken:", pageToken);

    const response = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
      fields:
        "nextPageToken, files(id, name, mimeType, thumbnailLink, webViewLink, webContentLink)",
      pageSize: 50,
      pageToken: pageToken || undefined, // ✅ safe pass
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

app.get("/thumbnail/:fileId", async (req, res) => {
  const { fileId } = req.params;
  try {
    const file = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );
    res.setHeader("Content-Type", "image/jpeg");
    file.data.pipe(res);
  } catch (err) {
    console.error(err);
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
