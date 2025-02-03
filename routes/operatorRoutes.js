<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Operator Dashboard – Enhanced Lot Tracking</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <!-- Google Fonts: Poppins for clarity and professionalism -->
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&display=swap" rel="stylesheet">
  <!-- Bootstrap CSS -->
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <!-- DataTables CSS -->
  <link href="https://cdn.datatables.net/1.13.6/css/dataTables.bootstrap5.min.css" rel="stylesheet">
  <!-- DataTables Responsive CSS -->
  <link href="https://cdn.datatables.net/responsive/2.4.1/css/responsive.bootstrap5.min.css" rel="stylesheet">
  <!-- Bootstrap Icons -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css">
  <style>
    /* Global Styles */
    body {
      font-family: 'Poppins', sans-serif;
      background-color: #fafafa;
      color: #333;
      margin: 0;
      padding-bottom: 2rem;
    }
    
    /* Navbar: Subtle dark header for a professional tone */
    .navbar {
      background-color: #2c3e50;
      border-bottom: 1px solid #222;
    }
    .navbar-brand {
      font-size: 1.8rem;
      font-weight: 600;
      color: #fff !important;
    }
    .navbar .btn {
      margin-left: 10px;
    }
    
    /* Cards: Clean, sharp, grid-aligned with white backgrounds */
    .card {
      background-color: #fff;
      border: 1px solid #ddd;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      margin-bottom: 1.5rem;
      border-radius: 0;
    }
    .card-header {
      background-color: #f7f7f7;
      border-bottom: 1px solid #ddd;
      font-size: 1.25rem;
      font-weight: 500;
    }
    
    /* Form Controls: Neutral tones with sharp edges */
    .form-control, .form-select {
      border: 1px solid #ccc;
      background-color: #fff;
      color: #333;
      border-radius: 0;
    }
    .form-control:focus, .form-select:focus {
      border-color: #0056b3;
      box-shadow: none;
    }
    ::placeholder {
      color: #6c757d;
    }
    
    /* Buttons: Professional, minimalist styling */
    .btn {
      border-radius: 0;
      padding: 0.5rem 1rem;
      font-weight: 500;
      transition: background-color 0.3s, transform 0.3s;
      border: none;
    }
    .btn-primary {
      background-color: #0056b3;
      color: #fff;
    }
    .btn-primary:hover {
      background-color: #004494;
    }
    .btn-success {
      background-color: #27ae60;
      color: #fff;
    }
    .btn-success:hover {
      background-color: #218838;
    }
    .btn-info {
      background-color: #17a2b8;
      color: #fff;
    }
    .btn-info:hover {
      background-color: #138496;
    }
    .btn:hover {
      transform: scale(1.02);
    }
    
    /* DataTables: Clean table styling */
    table.dataTable thead {
      background-color: #eee;
    }
    table.dataTable thead th {
      font-weight: 500;
      border: none;
    }
    table.dataTable tbody tr:hover {
      background-color: #f8f9fa;
    }
    table.dataTable tbody td {
      vertical-align: middle;
    }
    
    /* Leftover Badges: Minimal and informative */
    .leftover-badge {
      padding: 0.25rem 0.5rem;
      font-weight: 600;
      border: 1px solid transparent;
      display: inline-block;
      min-width: 50px;
      text-align: center;
      font-size: 0.9rem;
      border-radius: 0;
    }
    .leftover-negative {
      background-color: #e74c3c;
      color: #fff;
      border-color: #c0392b;
    }
    .leftover-zero {
      background-color: #f1c40f;
      color: #000;
      border-color: #f39c12;
    }
    .leftover-positive {
      background-color: #27ae60;
      color: #fff;
      border-color: #218838;
    }
    
    /* Modal: Crisp and professional */
    .modal-content {
      background-color: #fff;
      border: 1px solid #ddd;
      border-radius: 0;
    }
    .modal-header {
      background-color: #f7f7f7;
      border-bottom: 1px solid #ddd;
    }
    
    /* Headings */
    h1 {
      font-size: 2.25rem;
      font-weight: 500;
      text-align: center;
      margin-bottom: 1.5rem;
    }
  </style>
</head>
<body>
  <!-- Navbar -->
  <nav class="navbar navbar-dark">
    <div class="container-fluid">
      <a class="navbar-brand" href="#">
        <i class="bi bi-speedometer2"></i> Operator Dashboard
      </a>
      <div>
        <a class="btn btn-success btn-sm" href="/operator/dashboard/download-all-lots" target="_blank">
          <i class="bi bi-download"></i> Download All
        </a>

        <a class="btn btn-success btn-sm" href="/search-dashboard" target="_blank">
          <i class="bi bi-download"></i> Enhanced Search
        </a>
        

        <button class="btn btn-secondary btn-sm" onclick="window.print()">
          <i class="bi bi-printer"></i> Print Page
        </button>
      </div>
    </div>
  </nav>

  <div class="container py-4">
    <h1>Enhanced Lot Tracking</h1>
    
    <!-- Search and Filter Section -->
    <div class="card mb-4">
      <div class="card-body">
        <form method="GET" action="/operator/dashboard">
          <div class="row g-3">
            <div class="col-12 col-md-6 col-lg-3">
              <div class="input-group">
                <span class="input-group-text"><i class="bi bi-search"></i></span>
                <input type="text" name="search" class="form-control" placeholder="Search by Lot No" value="<%= query.search || '' %>">
              </div>
            </div>
            <div class="col-12 col-md-6 col-lg-3">
              <div class="input-group">
                <span class="input-group-text"><i class="bi bi-calendar-event"></i></span>
                <input type="date" name="startDate" class="form-control" placeholder="Start Date" value="<%= query.startDate || '' %>">
              </div>
            </div>
            <div class="col-12 col-md-6 col-lg-3">
              <div class="input-group">
                <span class="input-group-text"><i class="bi bi-calendar-event"></i></span>
                <input type="date" name="endDate" class="form-control" placeholder="End Date" value="<%= query.endDate || '' %>">
              </div>
            </div>
            <div class="col-12 col-md-6 col-lg-3">
              <div class="input-group">
                <span class="input-group-text"><i class="bi bi-sort-alpha-down"></i></span>
                <select name="sortField" class="form-select">
                  <option value="">Sort By</option>
                  <option value="lot_no" <%= query.sortField === 'lot_no' ? 'selected' : '' %>>Lot No</option>
                  <option value="sku" <%= query.sortField === 'sku' ? 'selected' : '' %>>SKU</option>
                </select>
              </div>
            </div>
          </div>
          <div class="mt-3 text-end">
            <button type="submit" class="btn btn-primary">
              <i class="bi bi-funnel-fill"></i> Apply Filters
            </button>
          </div>
        </form>
      </div>
    </div>
    
    <!-- Lot Tracking Table -->
    <div class="card">
      <div class="card-header">
        <i class="bi bi-table"></i> Lot Tracking
      </div>
      <div class="card-body">
        <% if (Object.keys(lotDetails).length === 0) { %>
          <p class="text-muted">No lots found.</p>
        <% } else { %>
          <!-- The table is wrapped in a responsive container provided by DataTables Responsive -->
          <table id="tableLotTracking" class="table table-bordered table-striped dt-responsive nowrap">
            <thead>
              <tr>
                <th><i class="bi bi-hash"></i> Lot No</th>
                <th><i class="bi bi-tags"></i> SKU</th>
                <th><i class="bi bi-person"></i> Created By</th>
                <th><i class="bi bi-scissors"></i> Cut Pieces</th>
                <th><i class="bi bi-needle"></i> Leftover (Stitch)</th>
                <th><i class="bi bi-droplet"></i> Leftover (Wash)</th>
                <th><i class="bi bi-check2-circle"></i> Leftover (Finish)</th>
                <th><i class="bi bi-gear"></i> Actions</th>
              </tr>
            </thead>
            <tbody>
              <% for (const lot_no in lotDetails) { 
                   const info = lotDetails[lot_no];
                   const sku = info.cuttingLot ? info.cuttingLot.sku : '';
                   const createdBy = info.cuttingLot ? info.cuttingLot.created_by : 'N/A';
                   const cutPieces = info.cuttingLot ? info.cuttingLot.total_pieces : 0;
                   const leftoverStitchVal = (info.leftoverStitch !== null) ? info.leftoverStitch : 'N/A';
                   const leftoverWashVal = (info.leftoverWash !== null) ? info.leftoverWash : 'N/A';
                   const leftoverFinishVal = (info.leftoverFinish !== null) ? info.leftoverFinish : 'N/A';
                   
                   // Function to generate a badge for leftover values
                   function leftoverBadge(val) {
                     if (typeof val === 'number') {
                       if (val < 0) return `<span class="badge bg-danger">${val}</span>`;
                       if (val === 0) return `<span class="badge bg-warning text-dark">${val}</span>`;
                       return `<span class="badge bg-success">${val}</span>`;
                     }
                     return `<span class="badge bg-secondary">${val}</span>`;
                   }
              %>
              <tr>
                <td><%= lot_no %></td>
                <td><%= sku %></td>
                <td><%= createdBy %></td>
                <td><%= cutPieces %></td>
                <td>
                  <%- leftoverBadge(leftoverStitchVal) %>
                  <small>(<%= info.stitchingAssignedUser ? info.stitchingAssignedUser : 'N/A' %>)</small>
                </td>
                <td>
                  <%- leftoverBadge(leftoverWashVal) %>
                  <small>(<%= info.washingAssignedUser ? info.washingAssignedUser : 'N/A' %>)</small>
                </td>
                <td>
                  <%- leftoverBadge(leftoverFinishVal) %>
                  <small>(<%= info.finishingAssignedUser ? info.finishingAssignedUser : 'N/A' %>)</small>
                </td>
                <td>
                  <button class="btn btn-info btn-sm edit-btn"
                    data-lot="<%= lot_no %>"
                    data-total="<%= cutPieces %>"
                    data-remark="<%= info.cuttingLot ? info.cuttingLot.remark : '' %>">
                    <i class="bi bi-pencil"></i> Edit
                  </button>
                  <a class="btn btn-success btn-sm ms-2" href="/operator/dashboard/lot-tracking/<%= lot_no %>/download" target="_blank">
                    <i class="bi bi-download"></i> Download
                  </a>
                </td>
              </tr>
              <% } %>
            </tbody>
          </table>
        <% } %>
      </div>
    </div>
  </div>
  
  <!-- Edit Lot Modal -->
  <div class="modal fade" id="editLotModal" tabindex="-1" aria-labelledby="editLotModalLabel" aria-hidden="true">
    <div class="modal-dialog">
      <form id="editLotForm" method="POST" action="/operator/dashboard/edit-lot">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="editLotModalLabel">
              <i class="bi bi-pencil-square"></i> Edit Lot Details
            </h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <input type="hidden" name="lot_no" id="editLotNo">
            <div class="mb-3">
              <label for="editTotalPieces" class="form-label">Total Pieces (Override)</label>
              <div class="input-group">
                <input type="number" class="form-control" name="total_pieces" id="editTotalPieces" required>
                <button class="btn btn-outline-secondary" type="button" id="cutButton">
                  <i class="bi bi-scissors"></i> Cut
                </button>
              </div>
            </div>
            <div class="mb-3">
              <label for="editRemark" class="form-label">Remark</label>
              <textarea class="form-control" name="remark" id="editRemark" rows="3"></textarea>
            </div>
            <p class="text-muted">Override the calculated total pieces. Use the "Cut" button to subtract pieces if needed.</p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">
              <i class="bi bi-x-circle"></i> Cancel
            </button>
            <button type="submit" class="btn btn-primary">
              <i class="bi bi-save"></i> Save Changes
            </button>
          </div>
        </div>
      </form>
    </div>
  </div>
  
  <!-- Scripts -->
  <!-- Bootstrap JS -->
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
  <!-- jQuery -->
  <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
  <!-- DataTables JS -->
  <script src="https://cdn.datatables.net/1.13.6/js/jquery.dataTables.min.js"></script>
  <script src="https://cdn.datatables.net/1.13.6/js/dataTables.bootstrap5.min.js"></script>
  <!-- DataTables Responsive JS -->
  <script src="https://cdn.datatables.net/responsive/2.4.1/js/dataTables.responsive.min.js"></script>
  <script>
    // Initialize DataTable with responsive extension
    $(document).ready(function() {
      $('#tableLotTracking').DataTable({
        responsive: true,
        pageLength: 10,
        lengthMenu: [10, 25, 50, 100],
        order: [[0, 'asc']]
      });
    });
    
    // Open the Edit modal and populate it with the selected lot's data.
    document.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const lot_no = this.getAttribute('data-lot');
        const total = this.getAttribute('data-total');
        const remark = this.getAttribute('data-remark');
        document.getElementById('editLotNo').value = lot_no;
        document.getElementById('editTotalPieces').value = total;
        document.getElementById('editRemark').value = remark;
        var editModal = new bootstrap.Modal(document.getElementById('editLotModal'));
        editModal.show();
      });
    });
    
    // Handle the "Cut" button functionality.
    document.getElementById('cutButton').addEventListener('click', function() {
      const currentVal = Number(document.getElementById('editTotalPieces').value);
      const cutAmount = prompt("Enter the number of pieces to cut:", "0");
      const cutNum = Number(cutAmount);
      if (!isNaN(cutNum) && cutNum > 0) {
        const newVal = currentVal - cutNum;
        if (newVal < 0) {
          alert("Resulting total cannot be negative!");
        } else {
          document.getElementById('editTotalPieces').value = newVal;
        }
      }
    });
  </script>
</body>
</html>
