async function askGemma(userPrompt: string): Promise<string> {
  const response = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemma3:4b',
      messages: [{ role: 'user', content: userPrompt }],
      stream: false,
    }),
  });
  if (!response.ok) throw new Error(`Local AI request failed (${response.status}). Make sure Ollama is running.`);

  const data: { message?: { content?: string } } = await response.json();
  const answer = data.message?.content?.trim();
  if (!answer) throw new Error('Local AI returned an empty recommendation. Please try again.');
  return answer;
}

export { askGemma };
