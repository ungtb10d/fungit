const signals = require('signals');

const programEvents = new signals.Signal();
module.exports = programEvents;
fungit.programEvents = programEvents;

programEvents.add(function (event) {
  console.log('Event:', event.event);
});
