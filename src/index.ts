#!/usr/bin/env node

import { Command } from 'commander';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load environment variables
config({ path: resolve(process.cwd(), '.env') });

const program = new Command();

program
  .name('meta-assistant')
  .description('Meta-Assistant CLI - Planner and Instruction Generator')
  .version('1.0.0');

// A placeholder for the plan command
program
  .command('plan')
  .description('Plan out a task and generate instructions.md')
  .argument('<goal>', 'The high-level goal you want to achieve')
  .action((goal) => {
    console.log(`Received goal: "${goal}"`);
    console.log('Entering Analyzer Phase... (not fully implemented yet)');
    // TODO: Initialize LLM, Start Loop
  });

program.parse(process.argv);
