/**
 * Initial Task Setup Script
 * 
 * This script initializes the MCP server with a set of starter tasks
 * for the BioTech Incremental Game project.
 */

const fs = require('fs-extra');
const path = require('path');

// Ensure the data directory exists
const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(DATA_DIR);

// Sample initial tasks for the project
const initialTasks = [
  {
    id: '1001',
    title: 'Set up Love2D project structure',
    description: 'Create the basic folder structure and main.lua file for the Love2D game project.',
    status: 'BACKLOG',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: '1002',
    title: 'Implement basic game loop and state management',
    description: 'Create a state management system to transition between game states (menu, game, settings, etc.) and implement the basic game loop.',
    status: 'BACKLOG',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: '1003',
    title: 'Design core resource system',
    description: 'Plan and implement the fundamental resource system that will form the basis of the incremental game mechanics.',
    status: 'BACKLOG',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: '1004',
    title: 'Create UI framework',
    description: 'Develop a flexible UI system that can handle different screens, buttons, tooltips, and other UI elements.',
    status: 'BACKLOG',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: '1005',
    title: 'Implement save/load system',
    description: 'Create a system to serialize game state and save/load progress, ensuring persistence between game sessions.',
    status: 'BACKLOG',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

// Sample initial game mechanics
const initialMechanics = [
  {
    id: '2001',
    name: 'Research Points',
    description: 'Primary progression resource earned through various lab activities.',
    implementation: null,
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: '2002',
    name: 'Lab Equipment',
    description: 'Purchasable items that increase research point generation.',
    implementation: null,
    dependencies: ['2001'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: '2003',
    name: 'Discoveries',
    description: 'Achievements that unlock new research paths and provide bonuses.',
    implementation: null,
    dependencies: ['2001'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: '2004',
    name: 'Prestige System',
    description: 'Reset mechanic that provides permanent bonuses for subsequent playthroughs.',
    implementation: null,
    dependencies: ['2001', '2002', '2003'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

// Initial project context
const initialContext = {
  activeTask: null,
  recentlyCompleted: [],
  upcomingPriorities: ['1001', '1002']
};

// Write to the data files
fs.writeJsonSync(path.join(DATA_DIR, 'tasks.json'), { tasks: initialTasks }, { spaces: 2 });
fs.writeJsonSync(path.join(DATA_DIR, 'mechanics.json'), { mechanics: initialMechanics }, { spaces: 2 });
fs.writeJsonSync(path.join(DATA_DIR, 'context.json'), initialContext, { spaces: 2 });

console.log('Initial tasks and mechanics have been set up in the MCP server data.');
console.log('Initial context configured with high-priority tasks.');
console.log('The system is now ready for development to begin.'); 