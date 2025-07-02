document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.toggle-salary').forEach(btn => {
    btn.addEventListener('click', () => {
      const container = btn.closest('.salary-container') || btn.parentElement;
      container.querySelectorAll('.salary-hidden').forEach(span => {
        const visible = span.dataset.visible === 'true';
        span.textContent = visible ? '****' : span.dataset.salary;
        span.dataset.visible = (!visible).toString();
      });
      const icon = btn.querySelector('i');
      if (icon) {
        icon.classList.toggle('fa-eye');
        icon.classList.toggle('fa-eye-slash');
      }
    });
  });
});
