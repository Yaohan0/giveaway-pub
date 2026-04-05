let currentUser = null;
let currentGiveaways = [];

function formatDateTime(dateString) {
  const date = new Date(dateString);

  return date.toLocaleString("en-SG", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function toDatetimeLocalValue(dateString) {
  const date = new Date(dateString);
  const pad = (n) => String(n).padStart(2, "0");

  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

function fromDatetimeLocalValue(value) {
  return value.replace("T", " ") + ":00";
}

function updateNavbar() {
  const guestLinks = document.getElementById("guestLinks");
  const userLinks = document.getElementById("userLinks");
  const createGiveawayLink = document.getElementById("createGiveawayLink");
  const logoutNavBtn = document.getElementById("logoutNavBtn");

  if (!guestLinks || !userLinks || !createGiveawayLink || !logoutNavBtn) return;

  if (currentUser) {
    guestLinks.style.display = "none";
    userLinks.style.display = "inline-flex";
    createGiveawayLink.style.display = currentUser.role === "admin" ? "inline" : "none";

    logoutNavBtn.onclick = async (e) => {
      e.preventDefault();
      await fetch("/api/logout", { method: "POST" });
      window.location.reload();
    };
  } else {
    guestLinks.style.display = "inline-flex";
    userLinks.style.display = "none";
  }
}

function openEditModal(giveaway) {
  const modal = document.getElementById("editModal");
  const editGiveawayId = document.getElementById("editGiveawayId");
  const editTitle = document.getElementById("editTitle");
  const editDescription = document.getElementById("editDescription");
  const editPrize = document.getElementById("editPrize");
  const editServerName = document.getElementById("editServerName");
  const editWinnerCount = document.getElementById("editWinnerCount");
  const editStartTime = document.getElementById("editStartTime");
  const editEndTime = document.getElementById("editEndTime");
  const editStatus = document.getElementById("editStatus");
  const msg = document.getElementById("editMsg");

  if (
    !modal ||
    !editGiveawayId ||
    !editTitle ||
    !editDescription ||
    !editPrize ||
    !editServerName ||
    !editWinnerCount ||
    !editStartTime ||
    !editEndTime ||
    !editStatus ||
    !msg
  ) {
    alert("Edit modal HTML is missing. Please update index.html and refresh.");
    return;
  }

  editGiveawayId.value = giveaway.id;
  editTitle.value = giveaway.title || "";
  editDescription.value = giveaway.description || "";
  editPrize.value = giveaway.prize || "";
  editServerName.value = giveaway.server_name || "";
  editWinnerCount.value = giveaway.winner_count || 1;
  editStartTime.value = toDatetimeLocalValue(giveaway.start_time);
  editEndTime.value = toDatetimeLocalValue(giveaway.end_time);
  editStatus.value = giveaway.status || "draft";
  msg.textContent = "";

  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeEditModal() {
  const modal = document.getElementById("editModal");
  if (!modal) return;
  modal.classList.add("hidden");
  document.body.style.overflow = "";
}

function setupModalEvents() {
  const closeBtn = document.getElementById("closeModalBtn");
  const cancelBtn = document.getElementById("cancelEditBtn");
  const backdrop = document.getElementById("modalBackdrop");
  const form = document.getElementById("editGiveawayForm");

  if (closeBtn) closeBtn.addEventListener("click", closeEditModal);
  if (cancelBtn) cancelBtn.addEventListener("click", closeEditModal);
  if (backdrop) backdrop.addEventListener("click", closeEditModal);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const modal = document.getElementById("editModal");
      if (modal && !modal.classList.contains("hidden")) {
        closeEditModal();
      }
    }
  });

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const msg = document.getElementById("editMsg");
      msg.textContent = "";

      const giveawayId = document.getElementById("editGiveawayId").value;
      const title = document.getElementById("editTitle").value.trim();
      const description = document.getElementById("editDescription").value.trim();
      const prize = document.getElementById("editPrize").value.trim();
      const server_name = document.getElementById("editServerName").value.trim();
      const winner_count = Number(document.getElementById("editWinnerCount").value);
      const start_time = document.getElementById("editStartTime").value;
      const end_time = document.getElementById("editEndTime").value;
      const status = document.getElementById("editStatus").value;

      if (!title || !prize || !start_time || !end_time || !winner_count) {
        msg.textContent = "Please fill in all required fields.";
        return;
      }

      if (new Date(end_time) <= new Date(start_time)) {
        msg.textContent = "End time must be later than start time.";
        return;
      }

      try {
        const res = await fetch(`/api/giveaways/${giveawayId}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title,
            description,
            prize,
            server_name,
            winner_count,
            start_time: fromDatetimeLocalValue(start_time),
            end_time: fromDatetimeLocalValue(end_time),
            status,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          msg.textContent = data.error || "Failed to update giveaway.";
          return;
        }

        closeEditModal();
        await loadGiveaways();
      } catch (err) {
        console.error(err);
        msg.textContent = "Failed to update giveaway.";
      }
    });
  }
}

async function loadMe() {
  try {
    const res = await fetch("/api/me");
    const data = await res.json();

    const userBox = document.getElementById("userBox");
    currentUser = data.user || null;

    updateNavbar();

    if (!currentUser) {
      userBox.innerHTML = `
        <div class="card">
          <p>You are not logged in.</p>
          <a href="login.html">Login</a>
        </div>
      `;
      return;
    }

    const verifiedText = currentUser.is_verified ? "Verified" : "Not Verified";

    userBox.innerHTML = `
      <div class="card">
        <p>
          Logged in as <strong>${currentUser.username}</strong> (${currentUser.role})
          <br />
          Email status: <strong>${verifiedText}</strong>
        </p>
        <button id="logoutBtn">Logout</button>
      </div>
    `;

    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        await fetch("/api/logout", { method: "POST" });
        window.location.reload();
      });
    }
  } catch (err) {
    console.error(err);
  }
}

async function loadWinners(giveawayId) {
  try {
    const res = await fetch(`/api/giveaways/${giveawayId}/winners`);
    if (!res.ok) return [];
    return await res.json();
  } catch (err) {
    console.error(err);
    return [];
  }
}

async function joinGiveaway(id) {
  try {
    const res = await fetch(`/api/giveaways/${id}/join`, {
      method: "POST",
    });

    const data = await res.json();
    alert(data.message || data.error);

    if (res.ok) {
      await loadGiveaways();
      await loadMe();
    }
  } catch (err) {
    console.error(err);
    alert("Failed to join giveaway.");
  }
}

async function drawWinners(id) {
  try {
    const res = await fetch(`/api/giveaways/${id}/draw`, {
      method: "POST",
    });

    const data = await res.json();
    alert(data.message || data.error);

    if (res.ok) {
      await loadGiveaways();
    }
  } catch (err) {
    console.error(err);
    alert("Failed to draw winners.");
  }
}

async function deleteGiveaway(id, title) {
  const confirmed = confirm(`Delete giveaway "${title}"? This cannot be undone.`);
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/giveaways/${id}`, {
      method: "DELETE",
    });

    const data = await res.json();
    alert(data.message || data.error);

    if (res.ok) {
      await loadGiveaways();
    }
  } catch (err) {
    console.error(err);
    alert("Failed to delete giveaway.");
  }
}

async function loadGiveaways() {
  try {
    const res = await fetch("/api/giveaways");
    const giveaways = await res.json();
    currentGiveaways = giveaways;

    const list = document.getElementById("giveawayList");
    list.innerHTML = "";

    for (const g of giveaways) {
      const winners = await loadWinners(g.id);

      const winnersHtml = winners.length
        ? winners.map((w) => `<li>${w.username}</li>`).join("")
        : "<li>No winners yet</li>";

      const card = document.createElement("div");
      card.className = "card";

      card.innerHTML = `
        <h3>${g.title}</h3>
        <p><strong>Prize:</strong> ${g.prize}</p>
        <p><strong>Description:</strong> ${g.description || "-"}</p>
        <p><strong>Server:</strong> ${g.server_name || "-"}</p>
        <p><strong>Host:</strong> ${g.host_name}</p>
        <p><strong>Winners:</strong> ${g.winner_count}</p>
        <p><strong>Status:</strong> ${g.status}</p>
        <p><strong>Start:</strong> ${formatDateTime(g.start_time)}</p>
        <p><strong>End:</strong> ${formatDateTime(g.end_time)}</p>
        <p><strong>Entrants:</strong> ${g.entrant_count}</p>

        <div class="winner-box">
          <p><strong>Winner List:</strong></p>
          <ul>${winnersHtml}</ul>
        </div>

        <div class="button-row">
          <button class="join-btn" data-id="${g.id}">Join</button>
          ${
            currentUser && currentUser.role === "admin"
              ? `
                <button class="draw-btn" data-id="${g.id}">Draw Winners</button>
                <button class="edit-btn" data-id="${g.id}">Edit</button>
                <button class="delete-btn" data-id="${g.id}" data-title="${g.title}">Delete</button>
              `
              : ""
          }
        </div>
      `;

      list.appendChild(card);

      const joinBtn = card.querySelector(".join-btn");
      if (joinBtn) {
        joinBtn.addEventListener("click", () => joinGiveaway(g.id));
      }

      const drawBtn = card.querySelector(".draw-btn");
      if (drawBtn) {
        drawBtn.addEventListener("click", () => drawWinners(g.id));
      }

      const editBtn = card.querySelector(".edit-btn");
      if (editBtn) {
        editBtn.addEventListener("click", () => openEditModal(g));
      }

      const deleteBtn = card.querySelector(".delete-btn");
      if (deleteBtn) {
        deleteBtn.addEventListener("click", () => deleteGiveaway(g.id, g.title));
      }
    }
  } catch (err) {
    console.error(err);
  }
}

async function init() {
  setupModalEvents();
  await loadMe();
  await loadGiveaways();
}

init();