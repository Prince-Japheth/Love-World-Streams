const { spawn } = require('child_process');
const path = require('path');
const proc = spawn('./bin/yt-dlp', [
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', '/Users/japheth/Downloads/test_video.mp4',
    'https://www.youtube.com/watch?v=R9KObRz90dM' // some video id
]);
proc.stdout.on('data', d => process.stdout.write(d));
proc.stderr.on('data', d => process.stderr.write(d));
proc.on('close', code => console.log('Exited', code));
