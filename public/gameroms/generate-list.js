import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import games from '../../src/games.ts';

// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const folderPath = path.join(__dirname);
// const outputFilePath = path.join(__dirname, '../../src', 'games.ts');

// fs.readdir(folderPath, (err, files) => {
//   if (err) {
//     console.error('Error reading directory:', err);
//     return;
//   }

//   const gameFiles = files.filter(file => {
//     const ext = path.extname(file).toLowerCase();
//     return ext === '.gb' || ext === '.gbc' || ext === '.zip';
//   });

//   const outputContent = `const games = ${JSON.stringify(gameFiles, null, 2)};\nexport default games;`;

//   fs.writeFile(outputFilePath, outputContent, err => {
//     if (err) {
//       console.error('Error writing games.ts file:', err);
//       return;
//     }

//     console.log('games.ts file has been generated successfully.');
//   });
// });

// delete all the game files from this directory that isn't included in the games array

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const folderPath = __dirname;

fs.readdir(folderPath, (err, files) => {
  if (err) {
    console.error('Error reading directory:', err);
    return;
  }

  const gameFiles = files.filter(file => {
    const ext = path.extname(file).toLowerCase();
    return ext === '.gb' || ext === '.gbc' || ext === '.zip';
  });

  const filesToDelete = gameFiles.filter(file => !games.includes(file));

  filesToDelete.forEach(file => {
    const filePath = path.join(folderPath, file);

    fs.unlink(filePath, err => {
      if (err) {
        console.error(`Error deleting file ${file}:`, err);
        return;
      }

      console.log(`Deleted file: ${file}`);
    });
  });

  console.log(`Found ${gameFiles.length} game files.`);
  console.log(`Keeping ${games.length} games.`);
  console.log(`Deleting ${filesToDelete.length} games.`);
});