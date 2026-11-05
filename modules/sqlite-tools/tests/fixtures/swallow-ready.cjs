// Preloaded into the SQLite helper by a test: the "ready" message never reaches the parent, like a helper that hangs while starting.
const send = process.send;
if (send) process.send = function (message, ...rest) { return message && message.ready ? true : send.call(this, message, ...rest); };
