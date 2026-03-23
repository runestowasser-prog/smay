async function loadSessionFromFile(url) {
  const res = await fetch(url);
  return await res.json();
}