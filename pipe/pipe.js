#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const yaml = require("js-yaml");
const https = require("https");
const http = require("http");

console.log("SA_TOKEN", process.env);
console.log("SA_URL", process.env.SA_URL);

// Configuration
const SA_URL = process.env.SA_URL || "https://zimmer.superannotate.com";
const SA_API_URL = `${SA_URL}/api/v1/custom_task`;
const SA_TOKEN = process.env?.SA_TOKEN || null;
const BITBUCKET_COMMIT = process.env.BITBUCKET_COMMIT || "HEAD";

/**
 * Read version from version.txt
 */
function getVersion() {
  try {
    const versionPath = path.resolve(__dirname, "version.txt");
    fs.readFile(versionPath, "utf8", (err, data) => {
      if (err) {
        return "unknown";
      }
    });
    const version = fs.readFileSync(versionPath, "utf-8").trim();
    return version;
  } catch (error) {
    console.warn("Warning: Could not read version.txt, using default");
    return "unknown";
  }
}

const VERSION = getVersion();

/**
 * Sanitize token by removing "Bearer " prefix and all whitespace
 */
function sanitizeToken(token) {
  if (!token) return "";

  // Remove "Bearer " prefix if present
  let cleanToken = token.replace(/^[Bb]earer\s+/, "");

  // Remove all whitespace (newlines, spaces, tabs)
  cleanToken = cleanToken.replace(/\s+/g, "");

  return cleanToken;
}

/**
 * Get changed files in a specific folder
 */
function getChangedFilesInFolder(folder) {
  try {
    // Configure git to trust the current directory (fixes dubious ownership error)
    const cwd = process.cwd();
    try {
      execSync(`git config --global --add safe.directory "${cwd}"`, {
        encoding: "utf-8",
        stdio: "ignore",
      });
    } catch (configError) {
      // Ignore config errors (might already be set)
    }

    // Normalize folder path (remove trailing slash, ensure it ends with / for matching)
    const normalizedFolder = folder.replace(/\/$/, "") + "/";

    // Get changed files in the current commit
    const changedFiles = execSync(
      `git log -m -1 --name-only --pretty="format:" ${BITBUCKET_COMMIT}`,
      { encoding: "utf-8" }
    );

    // Filter files that are in the specified folder
    const files = changedFiles
      .split("\n")
      .filter((file) => file.trim() && file.startsWith(normalizedFolder))
      .map((file) => file.replace(normalizedFolder, ""));

    return files;
  } catch (error) {
    console.error(`Error getting changed files in ${folder}:`, error.message);
    return [];
  }
}

/**
 * Get changed folders in actions/ directory
 */
function getChangedFolders() {
  try {
    // Configure git to trust the current directory (fixes dubious ownership error)
    const cwd = process.cwd();
    try {
      execSync(`git config --global --add safe.directory "${cwd}"`, {
        encoding: "utf-8",
        stdio: "ignore",
      });
    } catch (configError) {
      // Ignore config errors (might already be set)
    }

    // Get changed files in the current commit
    const changedFiles = execSync(
      `git log -m -1 --name-only --pretty="format:" ${BITBUCKET_COMMIT}`,
      { encoding: "utf-8" }
    );

    // Filter for files in actions/ and extract unique folder paths
    const folders = new Set();
    changedFiles.split("\n").forEach((file) => {
      if (file.startsWith("actions/")) {
        const parts = file.split("/");
        if (parts.length >= 2) {
          folders.add(`actions/${parts[1]}`);
        }
      }
    });
    return Array.from(folders);
  } catch (error) {
    console.error("Error detecting changed folders:", error.message);
    return [];
  }
}

/**
 * Validate config.yaml structure - check only if required keys exist
 */
function validateConfig(config, folder) {
  const errors = [];
  const requiredKeys = [
    "description",
    "memory",
    "interpreter",
    "time_limit",
    "concurrency",
  ];

  // Check if all required keys exist
  for (const key of requiredKeys) {
    if (!(key in config)) {
      errors.push(`'${key}' is required`);
    }
  }

  if (errors.length > 0) {
    return {
      error: `Invalid config.yaml in ${folder}:\n  - ${errors.join("\n  - ")}`,
    };
  }

  return null;
}

/**
 * Generate JSON payload from folder
 */
function generatePayload(folder) {
  try {
    const configPath = path.join(folder, "config.yaml");

    // Check if config.yaml exists
    if (!fs.existsSync(configPath)) {
      return { error: "No config.yaml found" };
    }

    // Load config
    let config;
    try {
      const configContent = fs.readFileSync(configPath, "utf-8");
      config = yaml.load(configContent);
    } catch (error) {
      return { error: `Invalid YAML: ${error.message}` };
    }

    // Validate config structure
    const validationError = validateConfig(config, folder);
    if (validationError) {
      return validationError;
    }

    // Find main.py file specifically
    const mainPyPath = path.join(folder, "main.py");

    if (!fs.existsSync(mainPyPath)) {
      return { error: "No main.py file found" };
    }

    // Read and encode the Python file content
    const fileContent = fs.readFileSync(mainPyPath);
    const encodedFile = encodeURIComponent(fileContent.toString("utf-8"));

    // Determine task name
    const taskName = path.basename(folder);
    // Construct config object
    const taskConfig = config;
    taskConfig.interpreter = config.interpreter;
    taskConfig.requirements = config.requirements;

    // Construct payload
    const payload = {
      name: taskName,
      description: config.description,
      memory: config.memory,
      time_limit: config.time_limit,
      concurrency: config.concurrency,
      config: taskConfig,
      file: encodedFile,
    };

    return payload;
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Generate minimal payload with only file content (for PATCH when only .py changed)
 */
function generateFileOnlyPayload(folder) {
  try {
    // Find main.py file specifically
    const mainPyPath = path.join(folder, "main.py");

    if (!fs.existsSync(mainPyPath)) {
      return { error: "No main.py file found" };
    }

    // Read and encode the Python file content
    const fileContent = fs.readFileSync(mainPyPath);
    const encodedFile = encodeURIComponent(fileContent.toString("utf-8"));

    // Return only file in payload
    return {
      file: encodedFile,
    };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Make HTTP request
 */
function makeRequest(url, options, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === "https:";
    const httpModule = isHttps ? https : http;

    const requestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };
    const req = httpModule.request(requestOptions, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

/**
 * Check if custom task exists
 */
async function checkTaskExists(name, apiToken) {
  const url = new URL(SA_API_URL);
  url.searchParams.append("name", name);

  try {
    const response = await makeRequest(url.toString(), {
      method: "GET",
      headers: {
        Authorization: apiToken,
        "Auth-Type": "sdk",
        Referer: "https://app.superannotate.com/",
        "Content-Type": "application/json",
        "User-Agent": `Bitbucket Pipeline: ${VERSION}`,
      },
    });
    // Parse ID from response
    const id = response.data?.results?.[0]?.id || response.data?.id || null;
    return id;
  } catch (error) {
    console.error("Error checking task existence:", error.message);
    return null;
  }
}

/**
 * Create or update custom task
 */
async function syncTask(folder, apiToken) {
  // Remove trailing slash
  const cleanFolder = folder.replace(/\/$/, "");

  // Check if config.yaml exists
  if (!fs.existsSync(path.join(cleanFolder, "config.yaml"))) {
    console.log(`⚠️  Skipping ${cleanFolder}: No config.yaml found.`);
    return;
  }

  // Check if main.py exists
  if (!fs.existsSync(path.join(cleanFolder, "main.py"))) {
    console.log(`⚠️  Skipping ${cleanFolder}: No main.py found.`);
    return;
  }

  console.log(`🔧 Processing folder: ${cleanFolder}`);
  console.log(` 📄 Found config.yaml`);
  console.log(` 📄 Found main.py`);

  // Generate full payload first (needed for task name)
  const fullPayload = generatePayload(cleanFolder);
  if (fullPayload.error) {
    console.error(`❌ Error processing ${cleanFolder}: ${fullPayload.error}`);
    // Validation errors should fail the pipeline
    if (fullPayload.error.includes("Invalid config.yaml")) {
      process.exit(1);
    }
    return;
  }

  const taskName = fullPayload.name;

  // Check if task exists
  console.log(`🔍 Checking existence`);
  const taskId = await checkTaskExists(taskName, apiToken);

  try {
    if (!taskId) {
      console.log(`🆕 Creating new action: ${taskName}`);

      // For new tasks, always use full payload
      const response = await makeRequest(
        SA_API_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: apiToken,
            "Auth-Type": "sdk",
            Referer: "https://app.superannotate.com/",
            "User-Agent": `Bitbucket Pipeline: ${VERSION}`,
          },
        },
        fullPayload
      );

      if (response.status >= 200 && response.status < 300) {
        console.log(`✔ Created successfully (${response.data?.id})`);
      } else {
        console.error(
          `❌ Failed to create task: ${JSON.stringify(response.data)}`
        );
      }
    } else {
      console.log(`✔ Existing task found (id=${taskId})`);
      // Check what files changed in this folder
      const changedFiles = getChangedFilesInFolder(cleanFolder);
      const onlyPyFilesChanged =
        changedFiles.length > 0 &&
        changedFiles.every((file) => file == "main.py") &&
        !changedFiles.some((file) => file === "config.yaml");

      let patchPayload;
      if (onlyPyFilesChanged) {
        patchPayload = generateFileOnlyPayload(cleanFolder);
        if (patchPayload.error) {
          console.warn(
            `⚠️  Error generating file-only payload, using full payload: ${patchPayload.error}`
          );
          patchPayload = fullPayload;
        }
      } else {
        patchPayload = fullPayload;
      }
      console.log(`♻ Updating action: ${taskName}`);
      const response = await makeRequest(
        `${SA_API_URL}/${taskId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: apiToken,
            "Auth-Type": "sdk",
            Referer: "https://app.superannotate.com/",
            "User-Agent": `Bitbucket Pipeline: ${VERSION}`,
          },
        },
        patchPayload
      );
      if (response.status >= 200 && response.status < 300) {
        console.log(`✔ Update successful`);
      } else {
        console.error(
          `❌ Failed to update task: ${JSON.stringify(response.data)}`
        );
      }
    }
  } catch (error) {
    console.error(`❌ Error syncing task ${taskName}:`, error.message);
  } finally {
    console.log("----------------------------------");
  }
}

/**
 * Main function
 */
async function main() {
  // Check if SA_TOKEN is set - fail immediately if not
  if (!SA_TOKEN) {
    console.error("Please check environment variables.");
    console.error("Ensure SA_TOKEN is defined.");
    process.exit(1);
  }

  // Sanitize token
  const apiToken = sanitizeToken(SA_TOKEN);

  // Get changed folders
  const changedFolders = getChangedFolders();

  // Process each changed folder
  for (const folder of changedFolders) {
    await syncTask(folder, apiToken);
  }
}

// Run main function
if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

module.exports = {
  sanitizeToken,
  getChangedFilesInFolder,
  getChangedFolders,
  generatePayload,
  generateFileOnlyPayload,
  checkTaskExists,
  syncTask,
};
