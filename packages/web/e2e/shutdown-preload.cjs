process.on('message', (message) => {
  if (message && typeof message === 'object' && message.type === 'cezar-e2e-shutdown') {
    process.emit('SIGINT')
  }
})
