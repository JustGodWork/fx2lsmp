const panel = document.getElementById("panel");
const status = document.getElementById("status");

window.addEventListener("message", (event) => {
  const data = event.data;
  if (data.type === "welcome") {
    document.getElementById("title").textContent = "Hello " + data.from + " (" + data.total + ")";
    document.getElementById("items").innerHTML = Object.keys(data.items)
      .map((key) => "<li>" + key + ": " + data.items[key] + "</li>")
      .join("");
    panel.classList.remove("hidden");
  } else if (data.type === "broadcast") {
    document.getElementById("broadcast").textContent = data.text;
  } else if (data.type === "toggle") {
    if (data.visible) panel.classList.remove("hidden");
    else panel.classList.add("hidden");
  }
});

document.getElementById("close").addEventListener("click", () => {
  fetch(`https://${GetParentResourceName()}/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "button" }),
  })
    .then((response) => response.json())
    .then((answer) => {
      status.textContent = answer.ok ? "closed" : "failed";
      panel.classList.add("hidden");
    });
});
