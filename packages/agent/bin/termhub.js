#!/usr/bin/env node
import { main } from '../dist/cli.js';

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
