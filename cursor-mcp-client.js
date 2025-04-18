const axios = require('axios');

// Base URL for the MCP server
const BASE_URL = 'http://localhost:3000';

// Helper function for making API requests
async function makeRequest(method, endpoint, data = null) {
  try {
    const response = await axios({
      method,
      url: `${BASE_URL}${endpoint}`,
      data,
      headers: {
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    console.error(`Error making ${method} request to ${endpoint}:`, error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
}

// MCP Server Tool Functions
// These are the functions that will be exposed to Cursor via tool calls

// Task Management
async function getTasks(status = null) {
  return makeRequest('post', '/api/tools/getTasks', { status });
}

async function addTask(title, description, status = 'BACKLOG', priority = 'normal') {
  return makeRequest('post', '/api/tools/addTask', { 
    title, 
    description, 
    status, 
    priority 
  });
}

async function updateTaskStatus(taskId, status) {
  return makeRequest('post', '/api/tools/updateTaskStatus', { taskId, status });
}

// Notes Management
async function getNotes(tag = null, relatedTask = null) {
  return makeRequest('post', '/api/tools/getNotes', { tag, relatedTask });
}

async function addNote(title, content, tags = [], relatedTask = null) {
  return makeRequest('post', '/api/tools/addNote', { 
    title, 
    content, 
    tags, 
    relatedTask 
  });
}

// Context Management
async function getContext() {
  return makeRequest('post', '/api/tools/getContext');
}

// Project Goals
async function getGoals() {
  return makeRequest('get', '/api/goals');
}

// Game Mechanics
async function getMechanics() {
  return makeRequest('get', '/api/mechanics');
}

async function addMechanic(name, description, implementation = null, dependencies = []) {
  return makeRequest('post', '/api/mechanics', {
    name,
    description,
    implementation,
    dependencies
  });
}

// Decision Logging
async function getDecisions() {
  return makeRequest('get', '/api/decisions');
}

async function addDecision(title, description, rationale, alternatives = [], relatedTask = null) {
  return makeRequest('post', '/api/decisions', {
    title,
    description,
    rationale,
    alternatives,
    relatedTask
  });
}

module.exports = {
  getTasks,
  addTask,
  updateTaskStatus,
  getNotes,
  addNote,
  getContext,
  getGoals,
  getMechanics,
  addMechanic,
  getDecisions,
  addDecision
}; 