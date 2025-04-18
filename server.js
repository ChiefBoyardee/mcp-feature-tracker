console.log('[EARLY] Script execution started.'); log('[EARLY] Script execution started.');
import { Server } from "@modelcontextprotocol/sdk/server/index.js"; // Core server components
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"; // Transport
import { ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"; // Import schemas, ErrorCode, AND McpError from types path
import fsExtra from 'fs-extra'; // Use fs-extra
import path from 'path';
import crypto from 'crypto'; // ADDED: Import crypto for hashing
import morgan from 'morgan'; // Keep for potential HTTP logging if added back later
import { fileURLToPath } from 'url'; // Needed for __dirname in ESM
import { v4 as uuidv4 } from 'uuid'; // Import UUID v4 generator
console.log('[EARLY] Importing sqlite3...'); log('[EARLY] Importing sqlite3...');
import sqlite3 from 'sqlite3'; // RESTORED
console.log('[EARLY] Imported sqlite3.'); log('[EARLY] Imported sqlite3.');
console.log('[EARLY] Importing sqlite...'); log('[EARLY] Importing sqlite...');
import { open } from 'sqlite'; // RESTORED
console.log('[EARLY] Imported sqlite.'); log('[EARLY] Imported sqlite.');

// --- Configuration via Environment Variables ---
const DEFAULT_DATA_DIR_NAME = '.mcp_data';
const DATA_DIR = process.env.MCP_DATA_DIR 
    ? path.resolve(process.env.MCP_DATA_DIR) // Resolve if absolute or relative path provided
    : path.join(__dirname, DEFAULT_DATA_DIR_NAME); // Default to relative to script

console.log(`[CONFIG] Using data directory: ${DATA_DIR}`);
log(`[CONFIG] Using data directory: ${DATA_DIR}`);

// Replicate __dirname functionality in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); // This now refers to the *server script's* directory

// --- Logging Setup ---
// SDK handles basic logging, but we might want custom file logging
const logFile = path.join(__dirname, 'api.log');
const accessLogStream = fsExtra.createWriteStream(logFile, { flags: 'a' });

// Simple file logger (can be used by handlers)
function log(message) {
  const timestamp = new Date().toISOString();
  try {
    fsExtra.appendFileSync(logFile, `[${timestamp}] [SDK_SERVER] ${message}\n`);
  } catch (e) {
    console.error(`Log function failed: ${e.message}`);
  }
}
log('--- SDK Server Script Starting ---');

// --- State Variables ---
let db = null; // Will hold the database connection
let isInitialized = false;
let currentDbPath = null; // Store the path being used

// --- Database Helper Functions ---
// (Keep sanitizeForFilename and getShortHash here)
// Function to sanitize project name for use in filename
function sanitizeForFilename(name) {
  if (!name) return 'unknown_project';
  // Replace problematic characters with underscores, convert to lowercase
  const sanitized = name.replace(/[^a-zA-Z0-9\-_]/g, '_').toLowerCase();
  // Prevent excessively long names (optional, adjust length as needed)
  return sanitized.substring(0, 50); 
}

// Function to get short hash of a string
function getShortHash(inputString) {
  const hash = crypto.createHash('sha1').update(inputString).digest('hex');
  return hash.substring(0, 8); // Use first 8 chars
}

// ADDED: Function to normalize path for consistent hashing
function normalizePathForHashing(inputPath) {
    if (!inputPath) return '';
    let normalized = path.normalize(inputPath);
    normalized = normalized.toLowerCase();
    // Remove trailing slash or backslash
    if (normalized.endsWith('\\') || normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  }


// Async function to initialize DB - NOW takes path as argument
// Renamed original to initializeDatabaseSchemaAndData
async function initializeDatabaseSchemaAndData(dbInstance) {
    try {
        // Enable Foreign Key support
        await dbInstance.exec('PRAGMA foreign_keys = ON;');
        log('Foreign key support enabled.');

        // Define table schemas
        log('Creating tables if they do not exist...');
        await dbInstance.exec(`
            CREATE TABLE IF NOT EXISTS goals (
                id TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT,
                status TEXT NOT NULL CHECK(status IN ('BACKLOG', 'IN_PROGRESS', 'DONE')),
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL
                -- dependsOn is handled via task_dependencies table
            );

            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT,
                tags TEXT, -- Storing tags as JSON string array
                relatedTask TEXT, -- Can be NULL
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL,
                FOREIGN KEY (relatedTask) REFERENCES tasks(id) ON DELETE SET NULL -- Set null if task deleted
            );

            CREATE TABLE IF NOT EXISTS decisions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT,
                rationale TEXT,
                alternatives TEXT, -- Storing alternatives as JSON string array
                relatedTask TEXT, -- Can be NULL
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL,
                FOREIGN KEY (relatedTask) REFERENCES tasks(id) ON DELETE SET NULL -- Set null if task deleted
            );

            CREATE TABLE IF NOT EXISTS task_dependencies (
                task_id TEXT NOT NULL,
                depends_on_task_id TEXT NOT NULL,
                PRIMARY KEY (task_id, depends_on_task_id),
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE, -- If task deleted, remove dependency link
                FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE -- If dependency deleted, remove link
            );

            CREATE TABLE IF NOT EXISTS context (
                key TEXT PRIMARY KEY,
                value TEXT -- Store JSON arrays or task IDs as text
            );
        `);
        log('Table creation/check complete.');

        // --- Initialize Context Table --- 
        log('Initializing context table...');
        // Use INSERT OR IGNORE to avoid errors if keys already exist
        await dbInstance.run(`INSERT OR IGNORE INTO context (key, value) VALUES (?, ?)`, 'activeTask', null);
        await dbInstance.run(`INSERT OR IGNORE INTO context (key, value) VALUES (?, ?)`, 'recentlyCompleted', '[]'); // Store as empty JSON array
        await dbInstance.run(`INSERT OR IGNORE INTO context (key, value) VALUES (?, ?)`, 'upcomingPriorities', '[]'); // Store as empty JSON array
        log('Context table initialized.');

        // Check if goals table is empty and add default if needed
        const goalCount = await dbInstance.get('SELECT COUNT(*) as count FROM goals');
        if (goalCount.count === 0) {
            log('Goals table is empty, adding default goal.');
            const defaultGoalId = uuidv4();
            const now = new Date().toISOString();
            await dbInstance.run(
                'INSERT INTO goals (id, text, createdAt, updatedAt) VALUES (?, ?, ?, ?)',
                defaultGoalId,
                'Define the primary objectives for this project.',
                now,
                now
            );
            log('Default goal added.');
        }

    } catch (err) {
        log(`!!! DATABASE SCHEMA/DATA INITIALIZATION FAILED: ${err.message}`);
        console.error("Database Schema/Data Initialization Failed:", err);
        // Don't exit process here, throw error to be caught by caller
        throw err; 
    }
}

// --- Helper function to ensure DB connection is ready ---
function ensureDbReady() {
    if (!isInitialized || !db) {
        log("Error: Server accessed before initialization or DB connection lost.");
        throw new McpError(ErrorCode.PreconditionFailed, 'Server not initialized or DB not connected. Call initializeProjectContext first.');
    }
    // Return the db instance for convenience, though handlers will use global `db`
    return db;
}

// Define allowed task statuses
const ALLOWED_TASK_STATUSES = ['BACKLOG', 'IN_PROGRESS', 'DONE'];

// Helper function to detect circular dependencies using SQLite Recursive CTE
const checkCircularDependency = async (taskId, potentialDependsOnIds) => {
    if (!potentialDependsOnIds || potentialDependsOnIds.length === 0) {
        return false; // No dependencies, no cycle
    }

    log(`Checking for circular dependency: Task ${taskId}, potential deps ${potentialDependsOnIds.join(', ')}`);

    // Construct the recursive query
    const query = `
        WITH RECURSIVE dependency_path(task_being_checked, current_node, path_string, is_cycle) AS (
            -- Anchor: Start with each potential new direct dependency
            SELECT
                ?,
                value,
                ',' || value || ',',
                0
            FROM json_each(?) -- Bind potentialDependsOnIds JSON array string

            UNION ALL

            -- Recursive Step: Follow dependencies of the current node
            SELECT
                dp.task_being_checked,
                td.depends_on_task_id,
                dp.path_string || td.depends_on_task_id || ',',
                -- Check if the next node is the original task OR already in the path
                CASE
                    WHEN td.depends_on_task_id = dp.task_being_checked THEN 1
                    WHEN dp.path_string LIKE ('%,' || td.depends_on_task_id || ',%') THEN 1
                    ELSE 0
                END
            FROM dependency_path dp
            JOIN task_dependencies td ON dp.current_node = td.task_id
            WHERE dp.is_cycle = 0 -- Stop traversing paths that already found a cycle
        )
        -- Final check: See if any path detected a cycle that involves the original task
        SELECT 1 
        FROM dependency_path 
        WHERE is_cycle = 1 AND current_node = ? 
        LIMIT 1;
    `;

    try {
        const potentialDepsJson = JSON.stringify(potentialDependsOnIds);
        // Bind: 1: taskId (task being checked), 2: potentialDepsJson, 3: taskId (check if cycle reaches it)
        const result = await db.get(query, taskId, potentialDepsJson, taskId);
        
        if (result) {
            log(`Circular dependency DETECTED for task ${taskId} with dependencies ${potentialDependsOnIds.join(', ')}`);
            return true; // Cycle detected!
        } else {
            log(`No circular dependency found for task ${taskId} with dependencies ${potentialDependsOnIds.join(', ')}`);
            return false; // No cycle found
        }
  } catch (error) {
        log(`!!! ERROR during circular dependency check for task ${taskId}: ${error.message}`);
        // Fail safe: If the check fails, maybe prevent the update?
        // Or allow it and log the error prominently?
        // Let's prevent the update if the check itself errors.
        throw new Error(`Circular dependency check failed: ${error.message}`);
    }
};

// --- Task Handlers (Refactored for SQLite) ---
async function handleGetTasks(params) {
  ensureDbReady(); // ADD THIS LINE to every handler
  try {
        let query = 'SELECT * FROM tasks';
        const queryParams = [];

    if (params.status) {
            // Ensure status is valid before using in query
            if (!ALLOWED_TASK_STATUSES.includes(params.status)) {
                 return { content: [{ type: "text", text: JSON.stringify({ error: `Invalid status filter: ${params.status}` }) }], isError: true };
            }
            query += ' WHERE status = ?';
            queryParams.push(params.status);
        }

        query += ' ORDER BY createdAt DESC';
        
        // Use the global db instance
        const tasks = await db.all(query, queryParams);
        
        // Optionally, fetch dependencies for each task here if needed for the list view?
        // For now, just return the tasks as stored.

        return { content: [{ type: "text", text: JSON.stringify({ tasks: tasks }, null, 2) }] };
  } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleGetTasks: ${error.message}`);
    return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to get tasks: ' + error.message }) }], isError: true };
  }
}

async function handleAddTask(params) {
  ensureDbReady(); // ADD THIS LINE to every handler
  try {
        // VALIDATE Title: Ensure title is provided and not just whitespace
        if (!params.title || params.title.trim() === '') {
            log('AddTask validation failed: Title is missing or empty.');
            return { content: [{ type: "text", text: JSON.stringify({ error: 'Task title cannot be empty.' }) }], isError: true };
        }

        // VALIDATE Status
        const status = params.status || 'BACKLOG';
        if (!ALLOWED_TASK_STATUSES.includes(status)) {
            return { content: [{ type: "text", text: JSON.stringify({ error: `Invalid status value: ${status}. Allowed values are: ${ALLOWED_TASK_STATUSES.join(', ')}` }) }], isError: true };
        }

        const dependsOnIds = params.dependsOn || [];
        // VALIDATE dependsOn task IDs exist
        if (dependsOnIds.length > 0) {
            // Use a parameterized query to check all dependencies at once
            const placeholders = dependsOnIds.map(() => '?').join(',');
            const existingDeps = await db.all(`SELECT id FROM tasks WHERE id IN (${placeholders})`, dependsOnIds);
            if (existingDeps.length !== dependsOnIds.length) {
                 const missingIds = dependsOnIds.filter(id => !existingDeps.some(dep => dep.id === id));
                 return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to add task: Dependency task(s) not found: ${missingIds.join(', ')}` }) }], isError: true };
            }
            // Note: Circular dependency check during add is complex. We rely on the update check for now.
        }

    const newTask = {
            id: uuidv4(),
      title: params.title,
            description: params.description || '',
            status: status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

        // Use a transaction to insert task and dependencies together
        await db.exec('BEGIN TRANSACTION');
        try {
            await db.run(
                'INSERT INTO tasks (id, title, description, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
                newTask.id, newTask.title, newTask.description, newTask.status, newTask.createdAt, newTask.updatedAt
            );

            // Insert dependencies into the junction table
            if (dependsOnIds.length > 0) {
                // ADDED: Check for circular dependency *before* inserting dependencies
                if (await checkCircularDependency(newTask.id, dependsOnIds)) {
                    // Since we are in a transaction, throw error to cause ROLLBACK
                    throw new Error(`Proposed dependencies create a circular reference.`);
                }
                const stmt = await db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)');
                for (const depId of dependsOnIds) {
                    await stmt.run(newTask.id, depId);
                }
                await stmt.finalize();
            }

            await db.exec('COMMIT');
            log(`Task ${newTask.id} added with ${dependsOnIds.length} dependencies.`);

            // --- Update Context for High Priority --- 
    if (params.priority === 'high') {
                try {
                    log(`Adding high priority task ${newTask.id} to upcoming priorities...`);
                    const upcomingRow = await db.get("SELECT value FROM context WHERE key = 'upcomingPriorities'");
                    const upcomingIds = JSON.parse(upcomingRow?.value || '[]');
                    if (!upcomingIds.includes(newTask.id)) { // Avoid duplicates
                        upcomingIds.push(newTask.id);
                        await db.run("UPDATE context SET value = ? WHERE key = 'upcomingPriorities'", JSON.stringify(upcomingIds));
                        log(`Context: Added ${newTask.id} to upcomingPriorities.`);
                    }
                } catch (contextError) {
                     log(`!!! WARNING: Failed to update context table after adding high priority task: ${contextError.message}`);
                     // Do not fail the main operation
                }
            }
            // --- End Context Update ---

        } catch (transactionError) {
            await db.exec('ROLLBACK');
            log(`Error during add task transaction for ${newTask.id}: ${transactionError.message}`);
            throw transactionError; // Rethrow to be caught by outer catch
        }

        // Fetch the newly added task to return it
        const addedTask = await db.get('SELECT * FROM tasks WHERE id = ?', newTask.id);
        // Fetch dependencies separately for the response object
        const dependencies = await db.all('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?', newTask.id);
        addedTask.dependsOn = dependencies.map(d => d.depends_on_task_id);

        return { content: [{ type: "text", text: JSON.stringify({ message: 'Task added successfully', task: addedTask }, null, 2) }] };

  } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleAddTask: ${error.message}`);
    return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to add task: ' + error.message }) }], isError: true };
  }
}

async function handleUpdateTaskStatus(params) {
   ensureDbReady(); // ADD THIS LINE to every handler
   try {
    const taskId = params.taskId;
    const status = params.status;

    // VALIDATE Status
    if (!ALLOWED_TASK_STATUSES.includes(status)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Invalid status value: ${status}. Allowed values are: ${ALLOWED_TASK_STATUSES.join(', ')}` }) }], isError: true };
    }

    // Check if task exists first
    const task = await db.get('SELECT id FROM tasks WHERE id = ?', taskId);
    if (!task) {
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Task not found' }) }], isError: true };
    }

    // DEPENDENCY STATUS CHECK (if moving to IN_PROGRESS or DONE)
    if (status === 'IN_PROGRESS' || status === 'DONE') {
        // Find IDs of tasks this task depends on
        const dependencies = await db.all('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?', taskId);
        const depIds = dependencies.map(d => d.depends_on_task_id);

        if (depIds.length > 0) {
            const placeholders = depIds.map(() => '?').join(',');
            // Find dependencies that are NOT done
            const incompleteDeps = await db.all(
                `SELECT id, title, status FROM tasks WHERE id IN (${placeholders}) AND status != 'DONE'`,
                depIds
            );

            if (incompleteDeps.length > 0) {
                return { content: [{ type: "text", text: JSON.stringify({ 
                    error: `Cannot set status to ${status} because the following dependencies are not DONE:`, 
                    incompleteDependencies: incompleteDeps 
                }) }], isError: true };
            }
        }
    }
    // END DEPENDENCY CHECK

    // Update the status
    const now = new Date().toISOString();
    const result = await db.run(
        'UPDATE tasks SET status = ?, updatedAt = ? WHERE id = ?',
        status, now, taskId
    );

    // No need to check result.changes as we already confirmed task exists

    // Fetch the updated task for the response
    const updatedTask = await db.get('SELECT * FROM tasks WHERE id = ?', taskId);
     // Fetch dependencies separately for the response object
    const updatedDependencies = await db.all('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?', taskId);
    updatedTask.dependsOn = updatedDependencies.map(d => d.depends_on_task_id);

    // --- Update Context Table --- 
    log(`Updating context table based on task ${taskId} status change to ${status}...`);
    try {
    if (status === 'IN_PROGRESS') {
            // Set this task as the active task
            await db.run("UPDATE context SET value = ? WHERE key = 'activeTask'", taskId);
            log(`Context: Set activeTask to ${taskId}`);
            // Remove from upcoming priorities if it was there
            const upcomingRow = await db.get("SELECT value FROM context WHERE key = 'upcomingPriorities'");
            const upcomingIds = JSON.parse(upcomingRow?.value || '[]');
            if (upcomingIds.includes(taskId)) {
                const newUpcoming = upcomingIds.filter(id => id !== taskId);
                await db.run("UPDATE context SET value = ? WHERE key = 'upcomingPriorities'", JSON.stringify(newUpcoming));
                log(`Context: Removed ${taskId} from upcomingPriorities.`);
            }
    } else if (status === 'DONE') {
            // If it was the active task, clear active task
            const activeTaskRow = await db.get("SELECT value FROM context WHERE key = 'activeTask'");
            if (activeTaskRow?.value === taskId) {
                await db.run("UPDATE context SET value = NULL WHERE key = 'activeTask'");
                 log(`Context: Cleared activeTask (was ${taskId}).`);
            }
            // Remove from upcoming priorities
            const upcomingRow = await db.get("SELECT value FROM context WHERE key = 'upcomingPriorities'");
            let upcomingIds = JSON.parse(upcomingRow?.value || '[]');
            if (upcomingIds.includes(taskId)) {
                upcomingIds = upcomingIds.filter(id => id !== taskId);
                await db.run("UPDATE context SET value = ? WHERE key = 'upcomingPriorities'", JSON.stringify(upcomingIds));
                log(`Context: Removed ${taskId} from upcomingPriorities.`);
            }
            // Add to the start of recently completed (and trim)
            const recentRow = await db.get("SELECT value FROM context WHERE key = 'recentlyCompleted'");
            let recentIds = JSON.parse(recentRow?.value || '[]');
            // Remove if already present to avoid duplicates and move to front
            recentIds = recentIds.filter(id => id !== taskId);
            recentIds.unshift(taskId); // Add to beginning
            if (recentIds.length > 5) {
                recentIds = recentIds.slice(0, 5); // Keep only the latest 5
            }
            await db.run("UPDATE context SET value = ? WHERE key = 'recentlyCompleted'", JSON.stringify(recentIds));
            log(`Context: Added ${taskId} to recentlyCompleted. New list length: ${recentIds.length}`);
        } else if (status === 'BACKLOG') {
             // If moved back to backlog, ensure it's not the active task
             const activeTaskRow = await db.get("SELECT value FROM context WHERE key = 'activeTask'");
            if (activeTaskRow?.value === taskId) {
                await db.run("UPDATE context SET value = NULL WHERE key = 'activeTask'");
                 log(`Context: Cleared activeTask (was ${taskId} - moved to BACKLOG).`);
            }
            // It could potentially be re-added to upcoming priorities here if needed, but we'll skip for now.
        }
    } catch (contextError) {
         log(`!!! WARNING: Failed to update context table after task status change: ${contextError.message}`);
         // Do not fail the whole operation, just log the context update error
    }
    // --- End Context Update ---

    return { content: [{ type: "text", text: JSON.stringify({ message: 'Task status updated successfully', task: updatedTask }, null, 2) }] };
  } catch (error) {
    // Handle potential McpError from ensureDbReady or other errors
    if (error instanceof McpError) throw error;
    log(`Error in handleUpdateTaskStatus: ${error.message}`);
    return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to update task status: ' + error.message }) }], isError: true };
  }
}

// INSERTING handleUpdateTask Refactored for SQLite
async function handleUpdateTask(params) {
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        const taskId = params.id;

        // ADDED: Check if any updatable fields were actually provided
        if (params.title === undefined && params.description === undefined && params.dependsOn === undefined) {
            log('UpdateTask called with no updatable fields.');
            // Fetch current task state just to return something useful, mirroring other handlers
            const currentTaskForInfo = await db.get('SELECT * FROM tasks WHERE id = ?', taskId);
             if (!currentTaskForInfo) {
                 // Handle case where ID itself is invalid but no fields were given
                 return { content: [{ type: "text", text: JSON.stringify({ error: 'Task not found' }) }], isError: true };
            }
             const currentDepsForInfo = await db.all('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?', taskId);
             currentTaskForInfo.dependsOn = currentDepsForInfo.map(d => d.depends_on_task_id);
            return { content: [{ type: "text", text: JSON.stringify({ 
                message: 'No fields provided to update for task.', 
                task: currentTaskForInfo // Return current state along with message
            }, null, 2) }] };
        }
        // --- End Added Check ---

        // --- Get Current Task State --- 
        const currentTask = await db.get('SELECT * FROM tasks WHERE id = ?', taskId);
        if (!currentTask) {
            return { content: [{ type: "text", text: JSON.stringify({ error: 'Task not found' }) }], isError: true };
        }

        // --- Prepare Updates --- 
        const setClauses = [];
        const queryParams = [];
        const now = new Date().toISOString();
        let newDependsOn = null; // Store new dependencies separately

        if (params.title !== undefined) {
            // VALIDATE Title: Ensure title is not being set to empty/whitespace
            if (params.title === null || params.title.trim() === '') {
                log('UpdateTask validation failed: Title cannot be set to empty.');
                return { content: [{ type: "text", text: JSON.stringify({ error: 'Task title cannot be empty.' }) }], isError: true };
            }
            setClauses.push('title = ?');
            queryParams.push(params.title);
        }
        if (params.description !== undefined) {
            setClauses.push('description = ?');
            queryParams.push(params.description);
        }
        // Note: Status update is handled by handleUpdateTaskStatus
        
        // --- Handle Dependency Update --- 
        if (params.dependsOn !== undefined) {
            if (!Array.isArray(params.dependsOn)) {
                return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to update task: dependsOn must be an array of task IDs.` }) }], isError: true };
            }
            newDependsOn = [...new Set(params.dependsOn)]; // Remove duplicates

            // Validate new dependencies
            for (const depId of newDependsOn) {
                if (depId === taskId) {
                   return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to update task: Task cannot depend on itself.` }) }], isError: true };
                }
                const taskExists = await db.get('SELECT 1 FROM tasks WHERE id = ?', depId);
                if (!taskExists) {
                    return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to update task: Dependency task with ID ${depId} not found.` }) }], isError: true };
                }
            }
            // Circular dependency check (using placeholder)
            if (await checkCircularDependency(taskId, newDependsOn)) {
                 return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to update task: Proposed dependencies create a circular reference.` }) }], isError: true };
            }
        }

        // --- Perform Updates in Transaction --- 
        await db.exec('BEGIN TRANSACTION');
        try {
            // Update basic task fields if any changed
            if (setClauses.length > 0) {
                 setClauses.push('updatedAt = ?');
                 queryParams.push(now);
                 queryParams.push(taskId); // For WHERE clause
                 const updateQuery = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`;
                 await db.run(updateQuery, queryParams);
            }

            // Update dependencies if provided
            if (newDependsOn !== null) {
                // Clear existing dependencies for this task
                await db.run('DELETE FROM task_dependencies WHERE task_id = ?', taskId);
                // Insert new dependencies
                if (newDependsOn.length > 0) {
                    const stmt = await db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)');
                    for (const depId of newDependsOn) {
                        await stmt.run(taskId, depId);
                    }
                    await stmt.finalize();
                }
                 // Also update the main task's updatedAt timestamp if ONLY dependencies changed
                 if(setClauses.length === 0) {
                    await db.run('UPDATE tasks SET updatedAt = ? WHERE id = ?', now, taskId);
                 }
                 log(`Dependencies for task ${taskId} updated.`);
            }
            
            await db.exec('COMMIT');

        } catch (transactionError) {
            await db.exec('ROLLBACK');
            log(`Error during update task transaction for ${taskId}: ${transactionError.message}`);
            throw transactionError; 
        }

        // --- Fetch Final State for Response --- 
        const updatedTask = await db.get('SELECT * FROM tasks WHERE id = ?', taskId);
        const finalDependencies = await db.all('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?', taskId);
        updatedTask.dependsOn = finalDependencies.map(d => d.depends_on_task_id);

        return { content: [{ type: "text", text: JSON.stringify({ message: 'Task updated successfully', task: updatedTask }, null, 2) }] };

    } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleUpdateTask: ${error.message}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to update task: ' + error.message }) }], isError: true };
    }
}

async function handleDeleteTask(params) {
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        const taskId = params.taskId;

        // --- Check if task exists --- 
        const task = await db.get('SELECT id FROM tasks WHERE id = ?', taskId);
        if (!task) {
            return { content: [{ type: "text", text: JSON.stringify({ warning: `Task with ID ${taskId} not found.` }) }] };
        }

        // --- Check for blocking dependencies (Tasks that depend on *this* task) --- 
        const dependents = await db.all('SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?', taskId);
        
        if (dependents.length > 0) {
             // Fetch titles for better error message
             const dependentIds = dependents.map(d => d.task_id);
             const placeholders = dependentIds.map(() => '?').join(',');
             const dependentTasks = await db.all(`SELECT id, title FROM tasks WHERE id IN (${placeholders})`, dependentIds);
             
             return { content: [{ type: "text", text: JSON.stringify({ 
                 error: `Cannot delete task ${taskId} because other tasks depend on it:`, 
                 dependentTasks: dependentTasks 
             }) }], isError: true };
        }

        // --- Delete the task --- 
        // Foreign Key constraints handle:
        // - Deleting rows from task_dependencies where task_id or depends_on_task_id matches (CASCADE)
        // - Setting relatedTask to NULL in notes where relatedTask matches (SET NULL)
        // - Setting relatedTask to NULL in decisions where relatedTask matches (SET NULL)
        const result = await db.run('DELETE FROM tasks WHERE id = ?', taskId);

        if (result.changes === 0) {
            // Should not happen if task check above passed, but as safety.
             return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to delete task with ID ${taskId}, task not found during delete operation.` }) }], isError: true };
        }

        // --- Clean up Context Table --- 
        log(`Cleaning context table references for deleted task ${taskId}...`);
        try {
             // Clear active task if it matches
            const activeTaskRow = await db.get("SELECT value FROM context WHERE key = 'activeTask'");
            if (activeTaskRow?.value === taskId) {
                await db.run("UPDATE context SET value = NULL WHERE key = 'activeTask'");
                log(`Context: Cleared activeTask (was deleted task ${taskId}).`);
            }
            // Remove from recently completed
            const recentRow = await db.get("SELECT value FROM context WHERE key = 'recentlyCompleted'");
            let recentIds = JSON.parse(recentRow?.value || '[]');
            if (recentIds.includes(taskId)) {
                recentIds = recentIds.filter(id => id !== taskId);
                await db.run("UPDATE context SET value = ? WHERE key = 'recentlyCompleted'", JSON.stringify(recentIds));
                log(`Context: Removed deleted task ${taskId} from recentlyCompleted.`);
            }
            // Remove from upcoming priorities
            const upcomingRow = await db.get("SELECT value FROM context WHERE key = 'upcomingPriorities'");
            let upcomingIds = JSON.parse(upcomingRow?.value || '[]');
            if (upcomingIds.includes(taskId)) {
                upcomingIds = upcomingIds.filter(id => id !== taskId);
                await db.run("UPDATE context SET value = ? WHERE key = 'upcomingPriorities'", JSON.stringify(upcomingIds));
                log(`Context: Removed deleted task ${taskId} from upcomingPriorities.`);
            }
        } catch (contextError) {
            log(`!!! WARNING: Failed to clean context table after deleting task ${taskId}: ${contextError.message}`);
            // Do not fail the delete operation itself, just log the context cleanup error
        }
        // --- End Context Cleanup ---

        return { content: [{ type: "text", text: JSON.stringify({ message: `Task ${taskId} deleted successfully. Related references updated automatically by database.` }) }] };

    } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleDeleteTask: ${error.message}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to delete task: ' + error.message }) }], isError: true };
    }
}

async function handleGetTaskDetails(params) {
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        const taskId = params.taskId;

        // Fetch the core task
        const task = await db.get('SELECT * FROM tasks WHERE id = ?', taskId);
        if (!task) {
            return { content: [{ type: "text", text: JSON.stringify({ error: `Task with ID ${taskId} not found` }) }], isError: true };
        }

        // Fetch tasks this task depends on (Dependencies)
        const dependencies = await db.all(`
            SELECT T.id, T.title, T.status 
            FROM tasks T 
            JOIN task_dependencies TD ON T.id = TD.depends_on_task_id 
            WHERE TD.task_id = ?
        `, taskId);

        // Fetch tasks that depend on this task (Dependents)
        const dependents = await db.all(`
            SELECT T.id, T.title, T.status 
            FROM tasks T 
            JOIN task_dependencies TD ON T.id = TD.task_id 
            WHERE TD.depends_on_task_id = ?
        `, taskId);

        // Fetch related notes
        const relatedNotesDb = await db.all('SELECT id, title, createdAt, updatedAt FROM notes WHERE relatedTask = ? ORDER BY createdAt DESC', taskId);
        // Note: Tags are not fetched here for brevity, could add if needed
        const relatedNotes = relatedNotesDb.map(n => ({ ...n })); // Basic info

        // Fetch related decisions
        const relatedDecisionsDb = await db.all('SELECT id, title, createdAt, updatedAt FROM decisions WHERE relatedTask = ? ORDER BY createdAt DESC', taskId);
        // Note: Alternatives not fetched here for brevity
        const relatedDecisions = relatedDecisionsDb.map(d => ({ ...d })); // Basic info

        // Add the dependsOn array to the main task object for consistency with other responses
        task.dependsOn = dependencies.map(d => d.id);

        const result = {
            task: task,
            relatedNotes: relatedNotes,
            relatedDecisions: relatedDecisions,
            dependencies: dependencies, // Full objects for context
            dependents: dependents    // Full objects for context
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleGetTaskDetails: ${error.message}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to get task details: ' + error.message }) }], isError: true };
    }
}

// --- Note Handlers (Refactored for SQLite) ---
async function handleGetNotes(params) {
  // log(`[handleGetNotes] ENTERED. Params: ${JSON.stringify(params)}`); // REMOVED ENTRY LOG
  ensureDbReady(); // ADD THIS LINE to every handler
  try {
        let query = 'SELECT * FROM notes';
        const queryParams = [];
        const whereClauses = [];

        if (params.relatedTask) {
            // log('[handleGetNotes] Filtering by relatedTask'); // REMOVED LOG
            whereClauses.push('relatedTask = ?');
            queryParams.push(params.relatedTask);
        }

        // RE-ENABLING TAG FILTER
        // log(`[handleGetNotes] BEFORE tag check. params.tag = ${params.tag}`); // REMOVED LOG
        if (params.tag) { // REMOVED '&& false'
            // log('[handleGetNotes] Filtering by tag - This SHOULD appear now'); // REMOVED LOG
            // ALTERNATIVE APPROACH: Use EXISTS with json_each to check for tag presence
            // This might be more compatible than the previous subquery approach.
            whereClauses.push('json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value = ?)');
            // log(`[handleGetNotes] AFTER push, whereClauses: ${JSON.stringify(whereClauses)}`); // REMOVED CONFIRMATION LOG
            queryParams.push(params.tag);
            // log(`[handleGetNotes] AFTER push, queryParams: ${JSON.stringify(queryParams)}`); // REMOVED CONFIRMATION LOG
        }

        if (whereClauses.length > 0) {
            query += ' WHERE ' + whereClauses.join(' AND ');
        }

        query += ' ORDER BY createdAt DESC'; // Example ordering

        log(`Executing getNotes query: ${query} with params: ${JSON.stringify(queryParams)}`); // Log query
        const notes = await db.all(query, queryParams);
        log(`getNotes query returned ${notes.length} notes.`); // Log result count

        // Parse tags from JSON string back to array for output
        const processedNotes = notes.map(note => ({
            ...note,
            tags: note.tags ? JSON.parse(note.tags) : [] // Handle null tags field
        }));

        return { content: [{ type: "text", text: JSON.stringify({ notes: processedNotes }, null, 2) }] };
  } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleGetNotes: ${error.message} ${error.stack}`); // Log stack trace
    return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to get notes: ' + error.message }) }], isError: true };
  }
}

async function handleAddNote(params) {
  ensureDbReady(); // ADD THIS LINE to every handler
  try {
        // Validate relatedTask exists if provided
        if (params.relatedTask) {
            const taskExists = await db.get('SELECT 1 FROM tasks WHERE id = ?', params.relatedTask);
            if (!taskExists) {
                return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to add note: Task with ID ${params.relatedTask} not found.` }) }], isError: true };
            }
        }

    const newNote = {
            id: uuidv4(),
      title: params.title,
            content: params.content || '',
            tags: JSON.stringify(params.tags || []), // Store tags as JSON string
      relatedTask: params.relatedTask || null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        await db.run(
            'INSERT INTO notes (id, title, content, tags, relatedTask, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
            newNote.id, newNote.title, newNote.content, newNote.tags, newNote.relatedTask, newNote.createdAt, newNote.updatedAt
        );

        // Fetch the added note (and parse tags back for the response)
        const addedNoteDb = await db.get('SELECT * FROM notes WHERE id = ?', newNote.id);
        const addedNote = { ...addedNoteDb, tags: JSON.parse(addedNoteDb.tags || '[]') }; 

        return { content: [{ type: "text", text: JSON.stringify({ message: 'Note added successfully', note: addedNote }, null, 2) }] };
  } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleAddNote: ${error.message}`);
    return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to add note: ' + error.message }) }], isError: true };
  }
}

async function handleUpdateNote(params) {
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        const noteId = params.id;
        let relatedTaskValidated = true; // Assume valid unless proven otherwise

        // Validate relatedTask exists if provided and not null
        if (params.relatedTask !== undefined && params.relatedTask !== null) {
            const taskExists = await db.get('SELECT 1 FROM tasks WHERE id = ?', params.relatedTask);
            if (!taskExists) {
                 relatedTaskValidated = false;
                 return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to update note: Task with ID ${params.relatedTask} not found.` }) }], isError: true };
            }
        }
        
        // Build the SET clause dynamically
        const setClauses = [];
        const queryParams = [];
        const now = new Date().toISOString();

        if (params.title !== undefined) {
            setClauses.push('title = ?');
            queryParams.push(params.title);
        }
        if (params.content !== undefined) {
            setClauses.push('content = ?');
            queryParams.push(params.content);
        }
        if (params.tags !== undefined) {
            setClauses.push('tags = ?');
            queryParams.push(JSON.stringify(params.tags || [])); // Store as JSON string
        }
        if (params.relatedTask !== undefined) {
             setClauses.push('relatedTask = ?');
             queryParams.push(params.relatedTask); // Already validated above
        }
        
        if (setClauses.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ message: 'No fields provided to update for note.' }) }] };
        }

        // Always update updatedAt
        setClauses.push('updatedAt = ?');
        queryParams.push(now);

        // Add the note ID for the WHERE clause
        queryParams.push(noteId);

        const query = `UPDATE notes SET ${setClauses.join(', ')} WHERE id = ?`;
        const result = await db.run(query, queryParams);

        if (result.changes === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ error: 'Note not found or no changes made' }) }], isError: true };
        }

        // Fetch the updated note
        const updatedNoteDb = await db.get('SELECT * FROM notes WHERE id = ?', noteId);
        const updatedNote = { ...updatedNoteDb, tags: JSON.parse(updatedNoteDb.tags || '[]') };

        return { content: [{ type: "text", text: JSON.stringify({ message: 'Note updated successfully', note: updatedNote }, null, 2) }] };
  } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleUpdateNote: ${error.message}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to update note: ' + error.message }) }], isError: true };
    }
}

async function handleDeleteNote(params) {
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        const result = await db.run('DELETE FROM notes WHERE id = ?', params.noteId);
        if (result.changes === 0) {
             return { content: [{ type: "text", text: JSON.stringify({ warning: `Note with ID ${params.noteId} not found.` }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ message: 'Note deleted successfully.' }) }] };
  } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleDeleteNote: ${error.message}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to delete note: ' + error.message }) }], isError: true };
    }
}

// --- Decision Handlers (Refactored for SQLite) ---
async function handleGetDecisions(params) { // Added params even if unused for consistency
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        let query = 'SELECT * FROM decisions';
        const queryParams = [];
        const whereClauses = [];

        // Optional: Add filtering like relatedTask if needed in the future
        // UPDATED: Now actually implementing relatedTask filter
        if (params && params.relatedTask) {
            log(`[handleGetDecisions] Filtering by relatedTask: ${params.relatedTask}`);
            whereClauses.push('relatedTask = ?');
            queryParams.push(params.relatedTask);
        }
        // Optional: Add filtering by text content? Not currently in schema.

        if (whereClauses.length > 0) {
            query += ' WHERE ' + whereClauses.join(' AND ');
        }

        query += ' ORDER BY createdAt DESC';

        log(`Executing getDecisions query: ${query} with params: ${JSON.stringify(queryParams)}`);
        const decisions = await db.all(query, queryParams);
        log(`getDecisions query returned ${decisions.length} decisions.`);

        // Parse alternatives from JSON string back to array
        const processedDecisions = decisions.map(decision => ({
            ...decision,
            alternatives: decision.alternatives ? JSON.parse(decision.alternatives) : []
        }));

        return { content: [{ type: "text", text: JSON.stringify({ decisions: processedDecisions }, null, 2) }] };
  } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleGetDecisions: ${error.message} ${error.stack}`); // Added stack trace
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to get decisions: ' + error.message }) }], isError: true };
    }
}

async function handleAddDecision(params) {
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        // Validate relatedTask exists if provided
        if (params.relatedTask) {
            const taskExists = await db.get('SELECT 1 FROM tasks WHERE id = ?', params.relatedTask);
            if (!taskExists) {
                return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to add decision: Task with ID ${params.relatedTask} not found.` }) }], isError: true };
            }
        }

        const newDecision = {
            id: uuidv4(),
            title: params.title,
            description: params.description || '',
            rationale: params.rationale || '',
            alternatives: JSON.stringify(params.alternatives || []), // Store as JSON string
            relatedTask: params.relatedTask || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

        await db.run(
            'INSERT INTO decisions (id, title, description, rationale, alternatives, relatedTask, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            newDecision.id, newDecision.title, newDecision.description, newDecision.rationale, newDecision.alternatives, newDecision.relatedTask, newDecision.createdAt, newDecision.updatedAt
        );

        // Fetch the added decision (and parse alternatives back)
        const addedDecisionDb = await db.get('SELECT * FROM decisions WHERE id = ?', newDecision.id);
        const addedDecision = { ...addedDecisionDb, alternatives: JSON.parse(addedDecisionDb.alternatives || '[]') };

        return { content: [{ type: "text", text: JSON.stringify({ message: 'Decision added successfully', decision: addedDecision }, null, 2) }] };
  } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleAddDecision: ${error.message}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to add decision: ' + error.message }) }], isError: true };
    }
}

async function handleUpdateDecision(params) {
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        const decisionId = params.id;

        // Validate relatedTask exists if provided and not null
        if (params.relatedTask !== undefined && params.relatedTask !== null) {
            const taskExists = await db.get('SELECT 1 FROM tasks WHERE id = ?', params.relatedTask);
            if (!taskExists) {
                 return { content: [{ type: "text", text: JSON.stringify({ error: `Failed to update decision: Task with ID ${params.relatedTask} not found.` }) }], isError: true };
            }
        }

        const setClauses = [];
        const queryParams = [];
        const now = new Date().toISOString();

        if (params.title !== undefined) { setClauses.push('title = ?'); queryParams.push(params.title); }
        if (params.description !== undefined) { setClauses.push('description = ?'); queryParams.push(params.description); }
        if (params.rationale !== undefined) { setClauses.push('rationale = ?'); queryParams.push(params.rationale); }
        if (params.alternatives !== undefined) { setClauses.push('alternatives = ?'); queryParams.push(JSON.stringify(params.alternatives || [])); }
        if (params.relatedTask !== undefined) { setClauses.push('relatedTask = ?'); queryParams.push(params.relatedTask); }

        if (setClauses.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ message: 'No fields provided to update for decision.' }) }] };
        }

        setClauses.push('updatedAt = ?');
        queryParams.push(now);
        queryParams.push(decisionId); // For WHERE clause

        const query = `UPDATE decisions SET ${setClauses.join(', ')} WHERE id = ?`;
        const result = await db.run(query, queryParams);

        if (result.changes === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ error: 'Decision not found or no changes made' }) }], isError: true };
        }

        // Fetch the updated decision
        const updatedDecisionDb = await db.get('SELECT * FROM decisions WHERE id = ?', decisionId);
        const updatedDecision = { ...updatedDecisionDb, alternatives: JSON.parse(updatedDecisionDb.alternatives || '[]') };

        return { content: [{ type: "text", text: JSON.stringify({ message: 'Decision updated successfully', decision: updatedDecision }, null, 2) }] };
  } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleUpdateDecision: ${error.message}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to update decision: ' + error.message }) }], isError: true };
    }
}

async function handleDeleteDecision(params) {
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        const result = await db.run('DELETE FROM decisions WHERE id = ?', params.decisionId);
        if (result.changes === 0) {
             return { content: [{ type: "text", text: JSON.stringify({ warning: `Decision with ID ${params.decisionId} not found.` }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ message: 'Decision deleted successfully.' }) }] };
    } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleDeleteDecision: ${error.message}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to delete decision: ' + error.message }) }], isError: true };
    }
}

// --- Goal Handlers (Refactored for SQLite) ---
async function handleGetGoals() {
  // console.log('[handleGetGoals] ENTERED'); // REMOVED CONSOLE LOG
  ensureDbReady(); // ADD THIS LINE to every handler
  try {
    log("Attempting to fetch goals..."); // DEBUG: Log entry
    // console.log('[handleGetGoals] Attempting db.all...'); // REMOVED CONSOLE LOG
    const goals = await db.all('SELECT * FROM goals ORDER BY createdAt');
    // console.log(`[handleGetGoals] db.all successful, fetched ${goals.length} goals.`); // REMOVED CONSOLE LOG
    log(`Fetched ${goals.length} goals raw: ${JSON.stringify(goals)}`); // DEBUG: Log raw data
    
    // DEBUG: Temporarily return only count - COMMENT OUT FOR NORMAL OPERATION
    // return { content: [{ type: "text", text: JSON.stringify({ goal_count: goals.length }) }] }; 

    // Original return - UNCOMMENT FOR NORMAL OPERATION
    // console.log('[handleGetGoals] Preparing to return successfully.'); // REMOVED CONSOLE LOG
    return { content: [{ type: "text", text: JSON.stringify({ goals: goals }, null, 2) }] }; 

  } catch (error) {
    // console.error(`[handleGetGoals] CAUGHT ERROR: ${error.message}`, error.stack); // REMOVED CONSOLE ERROR
    // Handle potential McpError from ensureDbReady or other errors
    if (error instanceof McpError) throw error;
    log(`Error in handleGetGoals: ${error.message} ${error.stack}`); // DEBUG: Log stack trace
    return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to retrieve goals: ' + error.message }) }], isError: true };
  }
}

async function handleAddGoal(params) {
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        const goals = await db.all('SELECT * FROM goals');
        const newGoal = {
            id: uuidv4(),
            text: params.text,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        await db.run(
            'INSERT INTO goals (id, text, createdAt, updatedAt) VALUES (?, ?, ?, ?)',
            newGoal.id, newGoal.text, newGoal.createdAt, newGoal.updatedAt
        );
        // Fetch the newly added goal to return it
        const addedGoal = await db.get('SELECT * FROM goals WHERE id = ?', newGoal.id);
        return { content: [{ type: "text", text: JSON.stringify({ message: 'Goal added successfully', goal: addedGoal }, null, 2) }] };
  } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to add goal: ' + error.message }) }], isError: true };
    }
}

async function handleUpdateGoal(params) {
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        const goals = await db.all('SELECT * FROM goals');
        const goalIndex = goals.findIndex(g => g.id === params.id);
        if (goalIndex === -1) {
            return { content: [{ type: "text", text: JSON.stringify({ error: 'Goal not found' }) }], isError: true };
        }
        const goal = goals[goalIndex];
        if (params.text !== undefined) {
             goal.text = params.text;
             goal.updatedAt = new Date().toISOString();
        } else {
            // Optionally return a message if no updatable fields were provided
             return { content: [{ type: "text", text: JSON.stringify({ message: 'No fields provided to update for goal.' }) }] };
        }
        await db.run(
            'UPDATE goals SET text = ?, updatedAt = ? WHERE id = ?',
            goal.text, goal.updatedAt, goal.id
        );
        return { content: [{ type: "text", text: JSON.stringify({ message: 'Goal updated successfully', goal: goal }, null, 2) }] };
    } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to update goal: ' + error.message }) }], isError: true };
    }
}

async function handleDeleteGoal(params) {
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        const goals = await db.all('SELECT * FROM goals');
        const initialLength = goals.length;
        await db.run('DELETE FROM goals WHERE id = ?', params.goalId);

        if (goals.length === initialLength) {
             return { content: [{ type: "text", text: JSON.stringify({ warning: `Goal with ID ${params.goalId} not found.` }) }] };
        }

        return { content: [{ type: "text", text: JSON.stringify({ message: 'Goal deleted successfully.' }) }] };
    } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to delete goal: ' + error.message }) }], isError: true };
    }
}

// --- Context, Search, Summary Handlers (Refactoring) ---
async function handleGetContext() {
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        log('Fetching context data...');
        // Fetch context values
        const activeTaskRow = await db.get("SELECT value FROM context WHERE key = 'activeTask'");
        const recentRow = await db.get("SELECT value FROM context WHERE key = 'recentlyCompleted'");
        const upcomingRow = await db.get("SELECT value FROM context WHERE key = 'upcomingPriorities'");

        const activeTaskId = activeTaskRow?.value; // Might be null
        const recentlyCompletedIds = JSON.parse(recentRow?.value || '[]');
        const upcomingPriorityIds = JSON.parse(upcomingRow?.value || '[]');

        log(`Raw context - Active: ${activeTaskId}, Recent: ${recentlyCompletedIds.length}, Upcoming: ${upcomingPriorityIds.length}`);

        const hydratedContext = { 
            activeTask: null, 
            recentlyCompleted: [], 
            upcomingPriorities: [],
            activeTaskNoteCount: 0, 
            activeTaskDecisionCount: 0
        };

        // Hydrate Active Task
        if (activeTaskId) {
            log(`Hydrating active task: ${activeTaskId}`);
            hydratedContext.activeTask = await db.get('SELECT * FROM tasks WHERE id = ?', activeTaskId);
            if (hydratedContext.activeTask) {
                 // Fetch counts for the active task
                 const noteCountResult = await db.get('SELECT COUNT(*) as count FROM notes WHERE relatedTask = ?', activeTaskId);
                 hydratedContext.activeTaskNoteCount = noteCountResult?.count || 0;
                 const decisionCountResult = await db.get('SELECT COUNT(*) as count FROM decisions WHERE relatedTask = ?', activeTaskId);
                 hydratedContext.activeTaskDecisionCount = decisionCountResult?.count || 0;
                 log(`Active task hydrated. Notes: ${hydratedContext.activeTaskNoteCount}, Decisions: ${hydratedContext.activeTaskDecisionCount}`);
            } else {
                 log(`Warning: Active task ID ${activeTaskId} found in context but not in tasks table.`);
                 // Optionally clear the invalid activeTask from context here?
                 // await db.run("UPDATE context SET value = NULL WHERE key = 'activeTask'");
            }
        }

        // Hydrate Recently Completed Tasks (fetch limited info)
        if (recentlyCompletedIds.length > 0) {
             log(`Hydrating ${recentlyCompletedIds.length} recent tasks...`);
             const placeholders = recentlyCompletedIds.map(() => '?').join(',');
             const recentTasks = await db.all(`SELECT id, title, status, updatedAt FROM tasks WHERE id IN (${placeholders})`, recentlyCompletedIds);
             // Preserve order from context
             hydratedContext.recentlyCompleted = recentlyCompletedIds
                 .map(id => recentTasks.find(task => task.id === id))
                 .filter(task => task); // Filter out any potentially missing tasks
             log(`Hydrated ${hydratedContext.recentlyCompleted.length} recent tasks.`);
        }

        // Hydrate Upcoming Priority Tasks (fetch limited info)
        if (upcomingPriorityIds.length > 0) {
            log(`Hydrating ${upcomingPriorityIds.length} upcoming tasks...`);
            const placeholders = upcomingPriorityIds.map(() => '?').join(',');
            const upcomingTasks = await db.all(`SELECT id, title, status, createdAt FROM tasks WHERE id IN (${placeholders})`, upcomingPriorityIds);
            // Preserve order from context
             hydratedContext.upcomingPriorities = upcomingPriorityIds
                 .map(id => upcomingTasks.find(task => task.id === id))
                 .filter(task => task); // Filter out any potentially missing tasks
             log(`Hydrated ${hydratedContext.upcomingPriorities.length} upcoming tasks.`);
        }

        return { content: [{ type: "text", text: JSON.stringify(hydratedContext, null, 2) }] };
    } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleGetContext: ${error.message} ${error.stack}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to get context: ' + error.message }) }], isError: true };
    }
}

async function handleSearchItems(params) {
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        const { 
            query: queryText, itemType, status: taskStatus, tags: noteTags, 
            createdAfter, createdBefore, updatedAfter, updatedBefore, 
            sortBy = 'createdAt', sortOrder = 'desc' 
        } = params;

        // --- Input Validation ---
        const ALLOWED_ITEM_TYPES = ["tasks", "notes", "decisions"];
        if (itemType && !ALLOWED_ITEM_TYPES.includes(itemType)) {
            log(`SearchItems validation failed: Invalid itemType: ${itemType}`);
            return { content: [{ type: "text", text: JSON.stringify({ error: `Invalid itemType parameter: ${itemType}. Allowed values are: ${ALLOWED_ITEM_TYPES.join(', ')}` }) }], isError: true };
        }
        // Note: ALLOWED_TASK_STATUSES is defined globally
        if (taskStatus && !ALLOWED_TASK_STATUSES.includes(taskStatus)) {
            log(`SearchItems validation failed: Invalid status: ${taskStatus}`);
            return { content: [{ type: "text", text: JSON.stringify({ error: `Invalid status parameter: ${taskStatus}. Allowed values are: ${ALLOWED_TASK_STATUSES.join(', ')}` }) }], isError: true };
        }
        // --- End Validation ---
        
        const queryLower = queryText ? queryText.toLowerCase() : '';
        let sql = '';
        const sqlParams = [];

        // Validate sort order
        const orderDirection = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        // Validate sort column (simple validation)
        const validSortColumns = {
            'createdAt': 'createdAt',
            'updatedAt': 'updatedAt',
            'title': 'title'
        };
        const orderByColumn = validSortColumns[sortBy] || 'createdAt';

        // --- Build UNION query for Tasks, Notes, Decisions --- 
        const selectClauses = [];

        // Task Select
        if (!itemType || itemType === 'tasks') {
            let taskSql = `SELECT id, title, description, status, createdAt, updatedAt, 'task' as type FROM tasks`;
            const taskWhere = [];
            if (taskStatus) { taskWhere.push('status = ?'); sqlParams.push(taskStatus); }
            if (queryLower) { taskWhere.push('(LOWER(title) LIKE ? OR LOWER(description) LIKE ?)'); sqlParams.push(`%${queryLower}%`, `%${queryLower}%`); }
            if (createdAfter) { taskWhere.push('createdAt > ?'); sqlParams.push(createdAfter); }
            if (createdBefore) { taskWhere.push('createdAt < ?'); sqlParams.push(createdBefore); }
            if (updatedAfter) { taskWhere.push('updatedAt > ?'); sqlParams.push(updatedAfter); }
            if (updatedBefore) { taskWhere.push('updatedAt < ?'); sqlParams.push(updatedBefore); }
            if (taskWhere.length > 0) { taskSql += ' WHERE ' + taskWhere.join(' AND '); }
            selectClauses.push(taskSql);
        }

        // Note Select
        if (!itemType || itemType === 'notes') {
            let noteSql = `SELECT id, title, content as description, NULL as status, createdAt, updatedAt, 'note' as type FROM notes`; // Alias content to description for UNION compatibility
            const noteWhere = [];
            if (noteTags && noteTags.length > 0) {
                 // Check if *any* tag matches - requires json_each
                 // IMPORTANT: This specific json_each syntax might need adjustment based on exact SQLite version & JSON1 extension availability.
                 // This version checks if the note's ID is in a subquery that finds notes containing any of the specified tags.
                 const tagPlaceholders = noteTags.map(() => '?').join(', ');
                 noteWhere.push(`id IN (SELECT notes.id FROM notes, json_each(notes.tags) WHERE json_each.value IN (${tagPlaceholders}))`);
                 sqlParams.push(...noteTags);
            }
            if (queryLower) { noteWhere.push('(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)'); sqlParams.push(`%${queryLower}%`, `%${queryLower}%`); }
             if (createdAfter) { noteWhere.push('createdAt > ?'); sqlParams.push(createdAfter); }
            if (createdBefore) { noteWhere.push('createdAt < ?'); sqlParams.push(createdBefore); }
            if (updatedAfter) { noteWhere.push('updatedAt > ?'); sqlParams.push(updatedAfter); }
            if (updatedBefore) { noteWhere.push('updatedAt < ?'); sqlParams.push(updatedBefore); }
            if (noteWhere.length > 0) { noteSql += ' WHERE ' + noteWhere.join(' AND '); }
            selectClauses.push(noteSql);
        }
        
        // Decision Select
        if (!itemType || itemType === 'decisions') {
            let decisionSql = `SELECT id, title, description, NULL as status, createdAt, updatedAt, 'decision' as type FROM decisions`;
            const decisionWhere = [];
            if (queryLower) { decisionWhere.push('(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(rationale) LIKE ?)'); sqlParams.push(`%${queryLower}%`, `%${queryLower}%`, `%${queryLower}%`); }
            if (createdAfter) { decisionWhere.push('createdAt > ?'); sqlParams.push(createdAfter); }
            if (createdBefore) { decisionWhere.push('createdAt < ?'); sqlParams.push(createdBefore); }
            if (updatedAfter) { decisionWhere.push('updatedAt > ?'); sqlParams.push(updatedAfter); }
            if (updatedBefore) { decisionWhere.push('updatedAt < ?'); sqlParams.push(updatedBefore); }
            if (decisionWhere.length > 0) { decisionSql += ' WHERE ' + decisionWhere.join(' AND '); }
             selectClauses.push(decisionSql);
        }

        if (selectClauses.length === 0) {
             return { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] }; // Nothing selected
        }

        // Combine with UNION ALL and add ORDER BY
        sql = selectClauses.join(' UNION ALL ');
        sql += ` ORDER BY ${orderByColumn} ${orderDirection}`; // Apply sorting

        log(`Executing search query: ${sql} with params: ${JSON.stringify(sqlParams)}`);
        const results = await db.all(sql, sqlParams);
        log(`Search returned ${results.length} results.`);

        // Structure the response to match previous format (type + item)
        // Also parse JSON fields (tags/alternatives) back for relevant types if needed in response
        const formattedResults = results.map(item => {
             let outputItem = { ...item };
             // Example: If you wanted tags/alternatives in the search results:
             // if (item.type === 'note' && item.tags) { 
             //    try { outputItem.tags = JSON.parse(item.tags); } catch(e){ outputItem.tags = []; } 
             // } 
             // if (item.type === 'decision' && item.alternatives) { 
             //    try { outputItem.alternatives = JSON.parse(item.alternatives); } catch(e){ outputItem.alternatives = []; } 
             // }
             return { type: item.type, item: outputItem };
        });

        return { content: [{ type: "text", text: JSON.stringify({ results: formattedResults }, null, 2) }] };

    } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleSearchItems: ${error.message} ${error.stack}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to search items: ' + error.message }) }], isError: true };
    }
}

async function handleGetProjectSummary() {
    ensureDbReady(); // ADD THIS LINE to every handler
    try {
        log("Fetching project summary...");
        const taskCounts = await db.all("SELECT status, COUNT(*) as count FROM tasks GROUP BY status");
        const totalNotes = await db.get("SELECT COUNT(*) as count FROM notes");
        const totalDecisions = await db.get("SELECT COUNT(*) as count FROM decisions");
        const totalGoals = await db.get("SELECT COUNT(*) as count FROM goals"); // Added goals count

        const tasksByStatus = taskCounts.reduce((acc, row) => {
            acc[row.status] = row.count;
            return acc;
        }, {});
        
        // Ensure all standard statuses are present, even if count is 0
        ALLOWED_TASK_STATUSES.forEach(status => {
            if (!tasksByStatus.hasOwnProperty(status)) {
                tasksByStatus[status] = 0;
            }
        });
        const totalTasks = Object.values(tasksByStatus).reduce((sum, count) => sum + count, 0);

        const summary = {
            totalTasks: totalTasks,
            tasksByStatus: tasksByStatus,
            totalNotes: totalNotes?.count || 0,
            totalDecisions: totalDecisions?.count || 0,
            totalGoals: totalGoals?.count || 0 // Added
        };

        log(`Project summary generated: Tasks=${summary.totalTasks}, Notes=${summary.totalNotes}, Decisions=${summary.totalDecisions}, Goals=${summary.totalGoals}`);
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    } catch (error) {
        // Handle potential McpError from ensureDbReady or other errors
        if (error instanceof McpError) throw error;
        log(`Error in handleGetProjectSummary: ${error.message}`);
        return { content: [{ type: "text", text: JSON.stringify({ error: 'Failed to get project summary: ' + error.message }) }], isError: true };
  }
}

// --- NEW HANDLER: Initialize Project Context (Restored to async function declaration) ---
async function handleInitializeProjectContext(params) {
    log(`Received initializeProjectContext request. Raw Path: ${params.workspaceFolderPath}`); // Log raw path
    if (isInitialized) {
        log(`Warning: initializeProjectContext called again. Current DB: ${currentDbPath}`);
        return { content: [{ type: "text", text: JSON.stringify({ message: "Context already initialized." }) }] };
    }

    const workspaceFolderPath = params.workspaceFolderPath;
    if (!workspaceFolderPath) {
        log("Error: workspaceFolderPath not provided in initializeProjectContext call.");
        throw new McpError(ErrorCode.InvalidParams, "Missing required parameter: workspaceFolderPath");
    }

    try {
        // NORMALIZE the path first!
        const normalizedPath = normalizePathForHashing(workspaceFolderPath);
        log(`Normalized path for hashing: ${normalizedPath}`); // Log normalized path

        // Calculate unique DB identifier based on NORMALIZED path for hash
        const projectName = path.basename(workspaceFolderPath); // Basename can use original path
        const sanitizedName = sanitizeForFilename(projectName);
        const projectPathHash = getShortHash(normalizedPath); // USE NORMALIZED PATH FOR HASH
        const uniqueDbIdentifier = `${sanitizedName}_${projectPathHash}`;
        
        // Define DB path using configured DATA_DIR
        // const DATA_DIR = path.join(__dirname, '.mcp_data'); // Store DB in server's .mcp_data folder <-- REMOVED OLD LINE
        const dbFilePath = path.join(DATA_DIR, `${uniqueDbIdentifier}.feature-tracker.db`); // Use configured DATA_DIR
        currentDbPath = dbFilePath; // Store the path being used

        log(`Initializing project context. DB Identifier: ${uniqueDbIdentifier}, Path: ${dbFilePath}`);

        // Ensure data directory exists
        await fsExtra.ensureDir(DATA_DIR);
        log(`Data directory ensured: ${DATA_DIR}`);
        
        // Open the database connection
        log(`Opening database connection to: ${dbFilePath}`);
        const tempDb = await open({
            filename: dbFilePath,
            driver: sqlite3.Database
        });
        log('Database connection established.');

        // Run schema/data initialization
        await initializeDatabaseSchemaAndData(tempDb);

        // Assign to global variable and set flag
        db = tempDb;
        isInitialized = true;
        log('--- Project Context Initialized ---');

        return { content: [{ type: "text", text: JSON.stringify({ message: `Initialization successful. Using database: ${uniqueDbIdentifier}` }) }] };

    } catch (error) {
        log(`!!! Error during initializeProjectContext: ${error.message}`, error.stack);
        // Reset state if initialization failed midway?
        db = null;
        isInitialized = false;
        currentDbPath = null;
        throw new McpError(ErrorCode.InternalError, `Failed to initialize project context: ${error.message}`);
  }
}

// --- Tool Schemas (Based on handler functions) ---
const tools = {
  getTasks: {
    name: "getTasks", description: "Get tasks for the current project",
    inputSchema: { type: "object", properties: { status: { type: "string", description: "Filter tasks by status" } }, required: [] }
  },
  addTask: {
    name: "addTask", description: "Add a new task",
    inputSchema: {
        type: "object",
        properties: {
            title: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ALLOWED_TASK_STATUSES, description: `Optional: Task status. Defaults to BACKLOG. Must be one of: ${ALLOWED_TASK_STATUSES.join(', ')}` },
            priority: { type: "string" }, // Priority not strictly enforced, kept for potential use
            dependsOn: { type: "array", items: { type: "string" }, description: "Optional: List of task IDs this task depends on." }
        },
        required: ["title", "description"]
    }
  },
  updateTaskStatus: {
    name: "updateTaskStatus", description: "Update the status of a task",
    inputSchema: {
        type: "object",
        properties: {
            taskId: { type: "string" },
            status: { type: "string", enum: ALLOWED_TASK_STATUSES, description: `The new task status. Must be one of: ${ALLOWED_TASK_STATUSES.join(', ')}` }
        },
        required: ["taskId", "status"]
    }
  },
  getNotes: {
    name: "getNotes", description: "Get notes",
    inputSchema: { type: "object", properties: { tag: { type: "string" }, relatedTask: { type: "string" } }, required: [] }
  },
  addNote: {
    name: "addNote", description: "Add a new note",
    inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, tags: { type: "array", items: { type: "string" } }, relatedTask: { type: "string" } }, required: ["title", "content"] }
  },
  getContext: {
    name: "getContext", description: "Get the current context",
    // MODIFIED: Added dummy parameter to satisfy SDK requirement
    inputSchema: { type: "object", properties: { random_string: { type: "string" } }, required: [] }
  },
  getGoals: {
    name: "getGoals", description: "Get project goals.",
    // MODIFIED: Added dummy parameter
    inputSchema: { type: "object", properties: { random_string: { type: "string" } }, required: [] }
  },
  getDecisions: {
    name: "getDecisions", description: "Get design decisions",
    // MODIFIED: Added dummy parameter AND optional relatedTask filter
    inputSchema: { 
        type: "object", 
        properties: { 
            random_string: { type: "string" },
            relatedTask: { type: "string", description: "Optional: Filter decisions by related task ID." } 
        }, 
        required: [] 
    } 
  },
  addDecision: {
    name: "addDecision", description: "Log a new design decision",
    inputSchema: {
        type: "object",
        properties: {
            title: { type: "string" },
            description: { type: "string" },
            rationale: { type: "string" },
            alternatives: { type: "array", items: { type: "string" } },
            relatedTask: { type: "string", description: "Optional: The ID of the task this decision relates to." }
        },
        required: ["title", "description", "rationale"]
    }
  },
  // NEW Tool Schema
  getTaskDetails: {
      name: "getTaskDetails", description: "Get details for a specific task, including related notes and decisions",
      inputSchema: { type: "object", properties: { taskId: { type: "string", description: "The ID of the task to retrieve details for" } }, required: ["taskId"] }
  },
  // NEW SEARCH Schema
  searchItems: {
      name: "searchItems", description: "Search across tasks, notes, and decisions with optional filters.",
      inputSchema: {
          type: "object",
          properties: {
              query: { type: "string", description: "Text to search for in titles and descriptions/content (case-insensitive)." },
              itemType: { type: "string", enum: ["tasks", "notes", "decisions"], description: "Optional: Filter results to a specific item type." },
              status: { type: "string", enum: ALLOWED_TASK_STATUSES, description: `Optional: Filter tasks by status. Only applies if itemType is 'tasks' or not specified. Must be one of: ${ALLOWED_TASK_STATUSES.join(', ')}` },
              tags: { type: "array", items: { type: "string" }, description: "Optional: Filter notes by tags. Note must have at least one of the specified tags. Only applies if itemType is 'notes' or not specified." },
              // Date Filters
              createdAfter: { type: "string", format: "date-time", description: "Optional: Find items created after this ISO 8601 timestamp." },
              createdBefore: { type: "string", format: "date-time", description: "Optional: Find items created before this ISO 8601 timestamp." },
              updatedAfter: { type: "string", format: "date-time", description: "Optional: Find items updated after this ISO 8601 timestamp." },
              updatedBefore: { type: "string", format: "date-time", description: "Optional: Find items updated before this ISO 8601 timestamp." },
              // Sorting
              sortBy: { type: "string", enum: ["createdAt", "updatedAt", "title"], description: "Optional: Field to sort results by. Defaults to createdAt.", default: "createdAt" },
              sortOrder: { type: "string", enum: ["asc", "desc"], description: "Optional: Sort order (ascending or descending). Defaults to desc.", default: "desc" }
          },
          required: []
      }
  },
  // NEW SUMMARY Schema
  getProjectSummary: {
      name: "getProjectSummary", description: "Get a summary of the project including counts of tasks by status, notes, and decisions.",
      inputSchema: { type: "object", properties: {}, required: [] } // No input needed
  },
  // NEW UPDATE SCHEMAS
  updateTask: {
      name: "updateTask", description: "Update properties of an existing task (excluding status).",
      inputSchema: {
          type: "object", 
          properties: {
              id: { type: "string", description: "The ID of the task to update." },
              title: { type: "string", description: "The new title for the task." },
              description: { type: "string", description: "The new description for the task." },
              dependsOn: { type: "array", items: { type: "string" }, description: "Optional: The complete new list of task IDs this task depends on." }
          },
          required: ["id"] 
      }
  },
  updateNote: {
      name: "updateNote", description: "Update properties of an existing note.",
      inputSchema: {
          type: "object",
          properties: {
              id: { type: "string", description: "The ID of the note to update." },
              title: { type: "string", description: "The new title for the note." },
              content: { type: "string", description: "The new content for the note." },
              tags: { type: "array", items: { type: "string" }, description: "The complete new list of tags for the note." },
              relatedTask: { type: "string", description: "The new related task ID, or null to remove the link." }
          },
          required: ["id"]
      }
  },
  updateDecision: {
      name: "updateDecision", description: "Update properties of an existing decision.",
      inputSchema: {
          type: "object",
          properties: {
              id: { type: "string", description: "The ID of the decision to update." },
              title: { type: "string", description: "The new title for the decision." },
              description: { type: "string", description: "The new description for the decision." },
              rationale: { type: "string", description: "The new rationale for the decision." },
              alternatives: { type: "array", items: { type: "string" }, description: "The complete new list of alternatives." },
              relatedTask: { type: "string", description: "The new related task ID, or null to remove the link." }
          },
          required: ["id"]
      }
  },
  // NEW DELETE SCHEMAS
  deleteNote: {
      name: "deleteNote", description: "Deletes a note by its ID.",
      inputSchema: {
          type: "object",
          properties: {
              noteId: { type: "string", description: "The ID of the note to delete." }
          },
          required: ["noteId"]
      }
  },
  deleteDecision: {
      name: "deleteDecision", description: "Deletes a decision by its ID.",
      inputSchema: {
          type: "object",
          properties: {
              decisionId: { type: "string", description: "The ID of the decision to delete." }
          },
          required: ["decisionId"]
      }
  },
  deleteTask: {
      name: "deleteTask", description: "Deletes a task by its ID, if no other tasks depend on it. Cleans up references in notes and decisions.",
      inputSchema: {
          type: "object",
          properties: {
              taskId: { type: "string", description: "The ID of the task to delete." }
          },
          required: ["taskId"]
      }
  },
  // NEW GOAL SCHEMAS
  addGoal: {
      name: "addGoal", description: "Add a new project goal.",
      inputSchema: {
          type: "object",
          properties: {
              text: { type: "string", description: "The text content of the goal." }
          },
          required: ["text"]
      }
  },
  updateGoal: {
      name: "updateGoal", description: "Update the text of an existing project goal.",
      inputSchema: {
          type: "object",
          properties: {
              id: { type: "string", description: "The ID of the goal to update." },
              text: { type: "string", description: "The new text content for the goal." }
          },
          required: ["id", "text"]
      }
  },
  deleteGoal: {
      name: "deleteGoal", description: "Deletes a project goal by its ID.",
      inputSchema: {
          type: "object",
          properties: {
              goalId: { type: "string", description: "The ID of the goal to delete." }
          },
          required: ["goalId"]
      }
  },
  // ADD NEW TOOL SCHEMA
  initializeProjectContext: {
    name: "initializeProjectContext",
    description: "Initializes the server context for a specific project workspace. MUST be called first.",
    inputSchema: {
        type: "object",
        properties: {
            workspaceFolderPath: { type: "string", description: "The absolute path to the project's workspace folder." }
        },
        required: ["workspaceFolderPath"]
    }
  },
};

// --- SDK Server Setup ---
const server = new Server(
  { name: "generic-feature-tracker-server", version: "1.0.0" }, // UPDATED name and reset version
  { capabilities: { tools: {} } } // Tools are listed dynamically via handler
);

// List Tools Handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log('Received ListTools request');
  return { tools: Object.values(tools) };
});

// Call Tool Handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  log(`Received CallTool request for: ${name}`);

  // Special case for initialization tool, doesn't need the ensureDbReady check yet
  if (name === tools.initializeProjectContext.name) {
    return await handleInitializeProjectContext(args);
  }

  // For all other tools, ensure initialized first
  // Note: ensureDbReady() is now called *inside* each handler
  // try { ensureDbReady(); } catch(err) { return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true }; }

  try {
  switch (name) {
    // Restored original case
    case tools.initializeProjectContext.name: return await handleInitializeProjectContext(args);
    case tools.getTasks.name: return await handleGetTasks(args);
    case tools.addTask.name: return await handleAddTask(args);
    case tools.updateTaskStatus.name: return await handleUpdateTaskStatus(args);
    case tools.getNotes.name: return await handleGetNotes(args);
    case tools.addNote.name: return await handleAddNote(args);
    case tools.getContext.name: return await handleGetContext();
      case tools.getGoals.name: 
        return await handleGetGoals(); 
      case tools.getDecisions.name: return await handleGetDecisions(args);
    case tools.addDecision.name: return await handleAddDecision(args);
      case tools.getTaskDetails.name: return await handleGetTaskDetails(args);
      case tools.searchItems.name: return await handleSearchItems(args);
      case tools.getProjectSummary.name: return await handleGetProjectSummary();
      case tools.updateTask.name: return await handleUpdateTask(args);
      case tools.updateNote.name: return await handleUpdateNote(args);
      case tools.updateDecision.name: return await handleUpdateDecision(args);
      case tools.deleteNote.name: return await handleDeleteNote(args);
      case tools.deleteDecision.name: return await handleDeleteDecision(args);
      case tools.deleteTask.name: return await handleDeleteTask(args);
      case tools.addGoal.name: return await handleAddGoal(args);
      case tools.updateGoal.name: return await handleUpdateGoal(args);
      case tools.deleteGoal.name: return await handleDeleteGoal(args);
    default:
      log(`Unknown tool called: ${name}`);
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    // Catch errors, including initialization errors from handlers
    console.error(`[Request Handler] Top-level error processing ${name}: ${error.message}`, error.stack);
    log(`!!! Request Handler caught top-level error: ${error.message}`);
    if (error instanceof McpError) {
      throw error;
    } else {
      throw new McpError(ErrorCode.InternalError, `Unhandled server error: ${error.message}`);
    }
  }
});

// --- Start Server ---
async function main() {
  log("--- SDK Server Script Starting (Awaiting Initialization) ---");
  // REMOVED: await initializeDatabase();
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Generic Feature Tracker MCP Server (SQLite) running on stdio - WAITING for initializeProjectContext call.");
}

main().catch((error) => {
  log(`Fatal error running server: ${error instanceof Error ? error.stack : String(error)}`); 
  console.error(`Fatal error running server: ${error instanceof Error ? error.stack : String(error)}`); 
  process.exit(1);
});