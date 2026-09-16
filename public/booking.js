// booking.js - Calendario con fechas bloqueadas por Airbnb/Bookings
// NOTA DE SEGURIDAD: los precios los calcula SIEMPRE el servidor.
// Este script solo envía fechas, número de huéspedes y tipo de reserva.
const PROD_API_URL = "https://escapelakenorman-api-l2da.onrender.com";
const API_URL = ["localhost", "127.0.0.1"].includes(window.location.hostname)
  ? `http://${window.location.hostname}:3001`
  : PROD_API_URL;

document.addEventListener("DOMContentLoaded", () => {
  const bookingForm = document.getElementById("booking-form");
  const bookingMessage = document.getElementById("booking-message");
  const priceDisplay = document.getElementById("price-display");
  const confirmModal = document.getElementById("confirm-modal");
  const confirmCancelBtn = document.getElementById("confirm-cancel");
  const confirmAcceptBtn = document.getElementById("confirm-accept");

  if (!bookingForm) return;

  // Estado de fechas bloqueadas (rangos completos)
  let bookedDateRanges = [];
  let currentRentalType = "short_stay"; // "short_stay" o "monthly"

  /**
   * Función que flatpickr usa para bloquear fechas.
   * Compara cada día del calendario contra los rangos bloqueados.
   */
  function isDateDisabled(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${d}`;

    for (const range of bookedDateRanges) {
      if (dateStr >= range.from && dateStr < range.to) {
        return true; // bloqueada
      }
    }
    return false; // disponible
  }

  /**
   * Formatear Date a YYYY-MM-DD (local, sin UTC)
   */
  function formatDateLocal(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // ============ RENTAL TYPE TOGGLE ============

  const rentalBtns = document.querySelectorAll(".rental-type-btn");
  const shortStayFields = document.getElementById("short-stay-fields");
  const monthlyFields = document.getElementById("monthly-fields");
  const monthlyStartInput = document.getElementById("monthly-start");
  const monthlyDurationSelect = document.getElementById("monthly-duration");
  const guestsSelect = document.getElementById("guests");

  /**
   * Activa únicamente los campos del tipo de reserva seleccionado.
   * Los campos ocultos se desactivan (disabled) y pierden el required,
   * así la validación del formulario solo comprueba los campos visibles.
   * Esto corrige el fallo que impedía reservar estancias de 10 a 29 noches
   * porque el campo mensual oculto seguía siendo obligatorio.
   */
  function setRentalType(type) {
    currentRentalType = type;
    const isMonthly = type === "monthly";

    shortStayFields.style.display = isMonthly ? "none" : "block";
    monthlyFields.style.display = isMonthly ? "block" : "none";

    shortStayFields.querySelectorAll("input, select").forEach((el) => {
      el.disabled = isMonthly;
      el.required = !isMonthly;
    });
    monthlyFields.querySelectorAll("input, select").forEach((el) => {
      el.disabled = !isMonthly;
      el.required = isMonthly;
    });

    if (isMonthly) {
      updateMonthlyPriceDisplay();
    } else {
      updatePriceDisplay();
    }
  }

  rentalBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      rentalBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      setRentalType(btn.dataset.type);
    });
  });

  // Estado inicial: Short Stay activo, campos mensuales desactivados
  setRentalType("short_stay");

  if (monthlyStartInput) {
    monthlyStartInput.addEventListener("change", updateMonthlyPriceDisplay);
  }
  if (monthlyDurationSelect) {
    monthlyDurationSelect.addEventListener("change", updateMonthlyPriceDisplay);
  }

  async function updateMonthlyPriceDisplay() {
    const startDate = monthlyStartInput.value;
    const months = parseInt(monthlyDurationSelect.value) || 3;

    if (!startDate) {
      if (priceDisplay) priceDisplay.innerHTML = "";
      return;
    }

    try {
      // El servidor calcula el precio con SU tarifa mensual; no enviamos precios
      const response = await fetch(`${API_URL}/api/calculate-price`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rental_type: "monthly",
          months,
        }),
      });

      if (response.ok) {
        const pricing = await response.json();
        const totalMonths = months;
        if (priceDisplay) {
          priceDisplay.innerHTML = `
            <div class="price-breakdown">
              <div class="price-row">
                <span>Monthly rate × ${totalMonths} month(s):</span>
                <span>$${pricing.subtotal.toFixed(2)}</span>
              </div>
              <div class="price-row tax-row">
                <span>Mecklenburg Sales Tax (${pricing.tax_rates.mecklenburg_sales.toFixed(2)}%):</span>
                <span>$${pricing.mecklenburg_sales_tax.toFixed(2)}</span>
              </div>
              <div class="price-row" style="color: #999; font-style: italic;">
                <span>Occupancy Tax:</span>
                <span>$0.00 (not applicable)</span>
              </div>
              <div class="price-row total-row">
                <span><strong>Total:</strong></span>
                <span><strong>$${pricing.total.toFixed(2)}</strong></span>
              </div>
            </div>
          `;
        }
      }
    } catch (error) {
      console.error("Error calculating monthly price:", error);
    }
  }

  // ============ FLATPICKR ============

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const commonOpts = {
    dateFormat: "Y-m-d",
    disableMobile: true,
    disable: [isDateDisabled],
    locale: {
      firstDayOfWeek: 0,
      rangeSeparator: " → ",
      scrollTitle: "Scroll to change",
      toggleTitle: "Click to toggle",
    },
    // Marcar fechas pasadas con clase CSS (gris, no clickeable)
    onDayCreate: function (dObj, dStr, fp, dayElem) {
      const dayDate = new Date(dayElem.dateObj);
      dayDate.setHours(0, 0, 0, 0);
      if (dayDate < today) {
        dayElem.classList.add("past-date");
      }
    },
  };

  // Check-in: hoy es selectable si no está bloqueado
  const checkinPicker = flatpickr("#checkin", {
    ...commonOpts,
    onChange: function (selectedDates) {
      if (selectedDates.length > 0) {
        // Solo evitamos rangos vacíos; el mínimo configurable lo valida el
        // servidor, que es la fuente de verdad para las reglas tarifarias.
        const minCheckout = new Date(selectedDates[0]);
        minCheckout.setDate(minCheckout.getDate() + 1);
        checkoutPicker.set("minDate", minCheckout);

        // Si checkout actual es menor al nuevo mínimo, limpiarlo
        const currentCheckout = checkoutPicker.selectedDates[0];
        if (currentCheckout && currentCheckout < minCheckout) {
          checkoutPicker.clear();
        }
      }
      updatePriceDisplay();
    },
  });

  // Check-out: hoy es selectable si no está bloqueado
  const checkoutPicker = flatpickr("#checkout", {
    ...commonOpts,
    onChange: function () {
      updatePriceDisplay();
    },
  });

  // ============ FECHAS BLOQUEADAS ============

  fetchBookedDates();
  setInterval(fetchBookedDates, 30000);

  async function fetchBookedDates() {
    try {
      const response = await fetch(`${API_URL}/api/bookings`);
      if (response.ok) {
        bookedDateRanges = await response.json();
        // Refrescar los calendarios con las nuevas fechas
        checkinPicker.set("disable", [isDateDisabled]);
        checkoutPicker.set("disable", [isDateDisabled]);
      }
    } catch (error) {
      console.error("Error fetching booked dates:", error);
    }
  }

  // ============ VALIDACIONES ============

  function isRangeAvailable(checkInDate, checkOutDate) {
    let current = new Date(checkInDate);
    const end = new Date(checkOutDate);
    while (current < end) {
      if (isDateDisabled(current)) return false;
      current.setDate(current.getDate() + 1);
    }
    return true;
  }

  // ============ PRECIO ============

  async function updatePriceDisplay() {
    const checkInDate = checkinPicker.selectedDates[0];
    const checkOutDate = checkoutPicker.selectedDates[0];

    if (!checkInDate || !checkOutDate) {
      if (priceDisplay) priceDisplay.innerHTML = "";
      return;
    }

    if (checkOutDate <= checkInDate) {
      if (priceDisplay) priceDisplay.innerHTML = "";
      return;
    }

    const nights = Math.round(
      (checkOutDate - checkInDate) / (1000 * 60 * 60 * 24),
    );

    if (priceDisplay) priceDisplay.innerHTML = "";
    if (bookingMessage && bookingMessage.className === "booking-message error") {
      bookingMessage.textContent = "";
      bookingMessage.className = "booking-message";
    }

    try {
      // El servidor calcula noches y precio con SU tarifa; solo enviamos fechas
      const response = await fetch(`${API_URL}/api/calculate-price`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkIn: formatDateLocal(checkInDate),
          checkOut: formatDateLocal(checkOutDate),
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        if (bookingMessage) {
          bookingMessage.textContent = error.error || "Failed to calculate price";
          bookingMessage.className = "booking-message error";
        }
        return;
      }

      const pricing = await response.json();
      const cleaningRow =
        pricing.cleaning_fee > 0
          ? `
              <div class="price-row">
                <span>Cleaning fee:</span>
                <span>$${pricing.cleaning_fee.toFixed(2)}</span>
              </div>`
          : "";
      if (priceDisplay) {
        priceDisplay.innerHTML = `
            <div class="price-breakdown">
              <div class="price-row">
                <span>Nightly rate × ${nights} nights:</span>
                <span>$${pricing.subtotal.toFixed(2)}</span>
              </div>${cleaningRow}
              <div class="price-row tax-row">
                <span>Mecklenburg Sales Tax (${pricing.tax_rates.mecklenburg_sales.toFixed(2)}%):</span>
                <span>$${pricing.mecklenburg_sales_tax.toFixed(2)}</span>
              </div>
              <div class="price-row tax-row">
                <span>Mecklenburg Occupancy Tax (${pricing.tax_rates.mecklenburg_occupancy.toFixed(2)}%):</span>
                <span>$${pricing.mecklenburg_occupancy_tax.toFixed(2)}</span>
              </div>
              <div class="price-row total-row">
                <span><strong>Total:</strong></span>
                <span><strong>$${pricing.total.toFixed(2)}</strong></span>
              </div>
            </div>
          `;
      }
    } catch (error) {
      if (priceDisplay) priceDisplay.innerHTML = "";
      if (bookingMessage) {
        bookingMessage.textContent = "Unable to calculate price. Please try again.";
        bookingMessage.className = "booking-message error";
      }
      console.error("Error calculating price:", error);
    }
  }

  // ============ MODAL DE CONFIRMACIÓN ============

  function showBookingConfirmation({ checkIn, checkOut, nights, pricing }) {
    document.getElementById("confirm-checkin").textContent = checkIn;
    document.getElementById("confirm-checkout").textContent = checkOut;
    document.getElementById("confirm-nights").textContent = nights;
    document.getElementById("confirm-base").textContent =
      `$${pricing.subtotal.toFixed(2)}`;
    document.getElementById("confirm-meck-sales").textContent =
      `$${pricing.mecklenburg_sales_tax.toFixed(2)}`;
    document.getElementById("confirm-meck-occupancy").textContent =
      `$${pricing.mecklenburg_occupancy_tax.toFixed(2)}`;
    document.getElementById("confirm-total").textContent =
      `$${pricing.total.toFixed(2)}`;

    confirmModal.classList.add("show");

    return new Promise((resolve) => {
      function cleanup(result) {
        confirmModal.classList.remove("show");
        confirmCancelBtn.removeEventListener("click", onCancel);
        confirmAcceptBtn.removeEventListener("click", onAccept);
        resolve(result);
      }
      function onCancel() {
        cleanup(false);
      }
      function onAccept() {
        cleanup(true);
      }
      confirmCancelBtn.addEventListener("click", onCancel);
      confirmAcceptBtn.addEventListener("click", onAccept);
    });
  }

  // ============ ENVÍO DEL FORMULARIO ============

  bookingForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    bookingMessage.textContent = "";
    bookingMessage.className = "booking-message";

    try {
      if (currentRentalType === "monthly") {
        // ── Arriendo Mensual ──
        const startDate = monthlyStartInput.value;
        const months = parseInt(monthlyDurationSelect.value) || 3;

        if (!startDate) {
          bookingMessage.textContent = "Please select a start date.";
          bookingMessage.className = "booking-message error";
          return;
        }

        // Calcular fechas de check-in y check-out para el calendario
        const start = new Date(startDate);
        const end = new Date(start);
        end.setMonth(end.getMonth() + months);
        const checkIn = formatDateLocal(start);
        const checkOut = formatDateLocal(end);

        bookingMessage.textContent = "Calculating price...";
        bookingMessage.className = "booking-message";

        const priceResponse = await fetch(`${API_URL}/api/calculate-price`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rental_type: "monthly",
            months,
          }),
        });

        if (!priceResponse.ok) throw new Error("Failed to calculate price");
        const pricing = await priceResponse.json();

        // Mostrar confirmación adaptada para mensual
        document.getElementById("confirm-checkin").textContent = checkIn;
        document.getElementById("confirm-checkout").textContent = checkOut;
        document.getElementById("confirm-nights").textContent =
          `${months} month(s)`;
        document.getElementById("confirm-base").textContent =
          `$${pricing.subtotal.toFixed(2)}`;
        document.getElementById("confirm-meck-sales").textContent =
          `$${pricing.mecklenburg_sales_tax.toFixed(2)}`;
        document.getElementById("confirm-meck-occupancy").textContent =
          `$0.00 (N/A)`;
        document.getElementById("confirm-total").textContent =
          `$${pricing.total.toFixed(2)}`;
        confirmModal.classList.add("show");

        const confirmed = await new Promise((resolve) => {
          function cleanup(result) {
            confirmModal.classList.remove("show");
            confirmCancelBtn.removeEventListener("click", onCancel);
            confirmAcceptBtn.removeEventListener("click", onAccept);
            resolve(result);
          }
          function onCancel() {
            cleanup(false);
          }
          function onAccept() {
            cleanup(true);
          }
          confirmCancelBtn.addEventListener("click", onCancel);
          confirmAcceptBtn.addEventListener("click", onAccept);
        });

        if (!confirmed) {
          bookingMessage.textContent = "";
          return;
        }

        bookingMessage.textContent = "Preparing secure payment... Please wait.";
        bookingMessage.className = "booking-message";

        const sessionResponse = await fetch(
          `${API_URL}/api/create-checkout-session`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              rental_type: "monthly",
              checkIn,
              months,
              guests: guestsSelect ? parseInt(guestsSelect.value) : 2,
            }),
          },
        );

        if (!sessionResponse.ok) {
          const errorData = await sessionResponse.json();
          throw new Error(
            errorData.error || "Failed to create payment session",
          );
        }

        const session = await sessionResponse.json();
        localStorage.setItem("pending_booking_checkIn", checkIn);
        localStorage.setItem("pending_booking_checkOut", checkOut);
        localStorage.setItem("pending_session_id", session.id);

        if (session.url) {
          window.location.href = session.url;
        } else {
          throw new Error("No checkout URL provided");
        }
      } else {
        // ── Estancia Corta ──
        const checkInDate = checkinPicker.selectedDates[0];
        const checkOutDate = checkoutPicker.selectedDates[0];

        if (!checkInDate || !checkOutDate) {
          bookingMessage.textContent =
            "Please select both check-in and check-out dates.";
          bookingMessage.className = "booking-message error";
          return;
        }

        const checkIn = formatDateLocal(checkInDate);
        const checkOut = formatDateLocal(checkOutDate);

        if (new Date(checkOut) <= new Date(checkIn)) {
          bookingMessage.textContent =
            "Check-out date must be after check-in date.";
          bookingMessage.className = "booking-message error";
          return;
        }

        const nights = Math.round(
          (checkOutDate - checkInDate) / (1000 * 60 * 60 * 24),
        );

        // Recargar fechas antes de validar
        await fetchBookedDates();

        if (!isRangeAvailable(checkInDate, checkOutDate)) {
          bookingMessage.textContent =
            "One or more dates in this range are no longer available. Please select different dates.";
          bookingMessage.className = "booking-message error";
          return;
        }

        bookingMessage.textContent = "Calculating price...";
        bookingMessage.className = "booking-message";

        const priceResponse = await fetch(`${API_URL}/api/calculate-price`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ checkIn, checkOut }),
        });

        if (!priceResponse.ok) {
          const error = await priceResponse.json().catch(() => ({}));
          throw new Error(error.error || "Failed to calculate price");
        }
        const pricing = await priceResponse.json();

        const confirmed = await showBookingConfirmation({
          checkIn,
          checkOut,
          nights,
          pricing,
        });
        if (!confirmed) {
          bookingMessage.textContent = "";
          return;
        }

        bookingMessage.textContent = "Preparing secure payment... Please wait.";
        bookingMessage.className = "booking-message";

        const sessionResponse = await fetch(
          `${API_URL}/api/create-checkout-session`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              checkIn,
              checkOut,
              guests: guestsSelect ? parseInt(guestsSelect.value) : 2,
            }),
          },
        );

        if (!sessionResponse.ok) {
          const errorData = await sessionResponse.json();
          throw new Error(
            errorData.error || "Failed to create payment session",
          );
        }

        const session = await sessionResponse.json();

        localStorage.setItem("pending_booking_checkIn", checkIn);
        localStorage.setItem("pending_booking_checkOut", checkOut);
        localStorage.setItem("pending_session_id", session.id);

        if (session.url) {
          window.location.href = session.url;
        } else {
          throw new Error("No checkout URL provided");
        }
      }
    } catch (error) {
      console.error("Payment error:", error);
      bookingMessage.textContent = `Error: ${error.message}. Please try again or contact us.`;
      bookingMessage.className = "booking-message error";
    }
  });
});
