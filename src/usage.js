const { Transform } = require('stream');

function countTokensApprox(text) {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function buildUsage(inputText, outputText, model, recordedUsage) {
  if (recordedUsage && typeof recordedUsage === 'object') {
    return recordedUsage;
  }
  return {
    input_tokens: countTokensApprox(inputText),
    output_tokens: countTokensApprox(outputText),
    model,
    approx: true
  };
}

function toSseStream(chunks) {
  const events = chunks.map((c) => (typeof c === 'string' ? c : JSON.stringify(c)));
  return Transform.from(events.map((e) => `data: ${e}\n\n`).join(''));
}

module.exports = { countTokensApprox, buildUsage, toSseStream };
