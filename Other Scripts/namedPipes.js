const net = require('net');
const path = '\\\\.\\pipe\\TestPipe';

const server = net.createServer((stream) => {
    console.log('MQL5 client connected!');
    
    // Buffer for incomplete messages
    let buffer = Buffer.alloc(0);
    
    stream.on('data', (chunk) => {
        // Accumulate data
        buffer = Buffer.concat([buffer, chunk]);
        
        // Process complete lines (split by newline)
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex).toString('utf8').trim();
            buffer = buffer.slice(newlineIndex + 1);
            
            console.log('Received from MQL5:', line);
            
            // Send UTF-8 response back
            const response = 'Hello from Node.js! Connection confirmed.\n';
            stream.write(Buffer.from(response, 'utf8'));
        }
    });
    
    stream.on('end', () => {
        console.log('MQL5 client disconnected');
    });
    
    stream.on('error', (err) => {
        console.error('Stream error:', err.message);
    });
});

server.listen(path, () => {
    console.log('Pipe server listening on', path);
    console.log('Run the MQL5 script now...');
});