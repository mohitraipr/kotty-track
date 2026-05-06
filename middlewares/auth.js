// middlewares/auth.js 

// Middleware to check if the user is authenticated
/*function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    req.flash('error', 'You must be logged in to view this page.');
    res.redirect('/login');
}*/
function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) {
      return next();
    } else {
      // If expecting JSON, return a JSON error response
      if (req.headers.accept && req.headers.accept.indexOf('application/json') !== -1) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      // Otherwise, redirect to login page
      req.flash('error', 'You must be logged in to view this page.');
      return res.redirect('/login');
    }
  }
  
// Middleware factory to check user roles
function hasRole(roleName) {
    return (req, res, next) => {
      if (req.session && req.session.user && req.session.user.roleName === roleName) {
        return next();
      }
      // Check if client expects JSON
      if (req.headers.accept && req.headers.accept.indexOf('application/json') !== -1) {
        return res.status(403).json({ error: 'You do not have permission to view this resource.' });
      }
      req.flash('error', 'You do not have permission to view this page.');
      return res.redirect('/');
    };
  }
  

// Specific role middlewares using the hasRole factory
function isAdmin(req, res, next) {
    return hasRole('admin')(req, res, next);
}

function isFabricManager(req, res, next) {
    return hasRole('fabric_manager')(req, res, next);
}

function isCuttingManager(req, res, next) {
    return hasRole('cutting_manager')(req, res, next);
}

function isStitchingMaster(req, res, next) {
    return hasRole('stitching_master')(req, res, next);
}
function isFinishingMaster(req, res, next) {
    return hasRole('finishing')(req, res, next);
}
function isCatalogUpload(req, res, next) {
    return hasRole('catalogUpload')(req, res, next);
}
function isWashingMaster(req, res, next) {
    if (req.session && req.session.user &&
        (req.session.user.roleName === 'washing' || req.session.user.roleName === 'washing_master')) {
      return next();
    }
    // For AJAX requests, return JSON error:
    if (req.headers.accept && req.headers.accept.indexOf('application/json') !== -1) {
      return res.status(403).json({ error: 'You do not have permission to view this resource.' });
    }
    req.flash('error', 'You do not have permission to view this page.');
    return res.redirect('/');
  }
  
function isJeansAssemblyMaster(req, res, next) {
    return hasRole('jeans_assembly')(req, res, next);
}
function isOperator(req, res, next) {
    return hasRole('operator')(req, res, next);
}
function isSupervisor(req, res, next) {
    return hasRole('supervisor')(req, res, next);
}
function isPaymentAuthoriser(req, res, next) {
    return hasRole('operator')(req, res, next);
}
function isAccountsAdmin(req, res, next) {
    return hasRole('accounts')(req, res, next);
}

// New Middleware for Washing In
function isWashingInMaster(req, res, next) {
  if (req.session && req.session.user &&
      (req.session.user.roleName === 'washing_in' || req.session.user.roleName === 'washing_in_master')) {
    return next();
  }
  // For AJAX requests, return JSON error:
  if (req.headers.accept && req.headers.accept.indexOf('application/json') !== -1) {
    return res.status(403).json({ error: 'You do not have permission to view this resource.' });
  }
  req.flash('error', 'You do not have permission to view this page.');
  return res.redirect('/');
}

function isDepartmentUser(req, res, next) {
    const departmentRoles = ['checking', 'quality_assurance'];
    if (req.session && req.session.user && departmentRoles.includes(req.session.user.roleName)) {
        return next();
    }
    req.flash('error', 'You do not have permission to view this page.');
    res.redirect('/');
}

function isStoreEmployee(req, res, next) {
    return hasRole('store_employee')(req, res, next);
}

function isStoreAdmin(req, res, next) {
    return hasRole('store_admin')(req, res, next);
}

function isIndentFiller(req, res, next) {
  return hasRole('indent_filler')(req, res, next);
}

function isStoreManager(req, res, next) {
  return hasRole('store_manager')(req, res, next);
}

function isMohitOperator(req, res, next) {
  const allowed = [
    'mohitOperator',
    'chandanSir',
    'sales',
    'sonuOpe',
    'mam',
  ];
  if (
    req.session &&
    req.session.user &&
    allowed.includes(req.session.user.username)
  ) {
    return next();
  }
  // Return JSON error for API requests
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (wantsJson || req.xhr) {
    return res.status(403).json({
      error: 'Permission denied',
      message: 'Only authorized users (mohitOperator, chandanSir, sales, sonuOpe, mam) can perform this action.',
      allowedUsers: allowed
    });
  }
  req.flash('error', 'You do not have permission to view this page.');
  return res.redirect('/');
}

function isOnlyMohitOperator(req, res, next) {
  const username = req.session?.user?.username;
  if (username && username.toLowerCase() === 'mohitoperator') {
    return next();
  }
  req.flash('error', 'You do not have permission to view this page.');
  return res.redirect('/');
}

function isPOCreator(req, res, next) {
  return hasRole('po_creator')(req, res, next);
}

function isNowiPOOrganization(req, res, next) {
  return hasRole('nowipoorganization')(req, res, next);
}

function isVendorFiles(req, res, next) {
  return hasRole('vendorfiles')(req, res, next);
}

function isVideoFinder(req, res, next) {
  return hasRole('videofinder')(req, res, next);
}

// Allow VMS recorder access: explicit videocreator role, mohitOperator
// (for ops/debug), or any user the project's broader operator group can use.
function isVideoCreator(req, res, next) {
  const user = req.session?.user;
  if (!user) {
    req.flash('error', 'Please login first.');
    return res.redirect('/login');
  }
  const username = (user.username || '').toLowerCase();
  const role = (user.roleName || '').toLowerCase();
  if (role === 'videocreator' || role === 'videofinder' || role === 'vmsoperator' ||
      role === 'admin' || username === 'mohitoperator') {
    return next();
  }
  const wantsJson = req.headers.accept?.includes('application/json') || req.xhr;
  if (wantsJson) return res.status(403).json({ error: 'Permission denied' });
  return res.status(403).send(
    `<div style="font-family:system-ui;padding:40px;max-width:600px;margin:60px auto;text-align:center;">
       <h2>403 — Permission denied</h2>
       <p>The <code>videocreator</code>, <code>videofinder</code>, or <code>vmsoperator</code> role is required for this page.</p>
       <p style="color:#64748b;font-size:0.9rem;">You're logged in as <strong>${user.username}</strong>${role ? ` (${role})` : ''}.</p>
       <p><a href="/">Back to dashboard</a></p>
     </div>`
  );
}

// vmsOperator: uploads AWBs, sees mail/video dashboards.
function isVmsOperator(req, res, next) {
  const user = req.session?.user;
  if (!user) {
    req.flash('error', 'Please login first.');
    return res.redirect('/login');
  }
  const username = (user.username || '').toLowerCase();
  const role = (user.roleName || '').toLowerCase();
  if (role === 'vmsoperator' || username === 'mohitoperator' || role === 'admin') {
    return next();
  }
  const wantsJson = req.headers.accept?.includes('application/json') || req.xhr;
  if (wantsJson) return res.status(403).json({ error: 'Permission denied' });
  // Render a 403 directly instead of redirecting — prevents loops with /login
  return res.status(403).send(
    `<div style="font-family:system-ui;padding:40px;max-width:600px;margin:60px auto;text-align:center;">
       <h2>403 — Permission denied</h2>
       <p>The <code>vmsoperator</code> role is required for this page.</p>
       <p style="color:#64748b;font-size:0.9rem;">You're logged in as <strong>${user.username}</strong>${role ? ` (${role})` : ''}.</p>
       <p><a href="/">Back to dashboard</a></p>
     </div>`
  );
}

function isProductViewer(req, res, next) {
  return hasRole('productviewer')(req, res, next);
}

// ---------------------------------------------------------------------------
// Helper to restrict routes to specific user ids
function allowUserIds(ids) {
  return function (req, res, next) {
    if (req.session && req.session.user && ids.includes(req.session.user.id)) {
      return next();
    }

    if (req.headers.accept && req.headers.accept.indexOf('application/json') !== -1) {
      return res.status(403).json({ error: 'You do not have permission to view this resource.' });
    }
    req.flash('error', 'You do not have permission to view this page.');
    return res.redirect('/');
  };
}

// ---------------------------------------------------------------------------
// Helper to restrict routes to specific roles
function allowRoles(roles) {
  return function (req, res, next) {
    if (req.session && req.session.user && roles.includes(req.session.user.roleName)) {
      return next();
    }

    if (req.headers.accept && req.headers.accept.indexOf('application/json') !== -1) {
      return res.status(403).json({ error: 'You do not have permission to view this resource.' });
    }
    req.flash('error', 'You do not have permission to view this page.');
    return res.redirect('/');
  };
}

// ---------------------------------------------------------------------------
// Restrict access to specific usernames (case-insensitive)
function allowUsernames(usernames) {
  return function (req, res, next) {
    const username = req.session?.user?.username;
    if (username && usernames.map((u) => u.toLowerCase()).includes(username.toLowerCase())) {
      return next();
    }

    if (req.headers.accept && req.headers.accept.indexOf('application/json') !== -1) {
      return res.status(403).json({ error: 'You do not have permission to view this resource.' });
    }
    req.flash('error', 'You do not have permission to view this page.');
    return res.redirect('/');
  };
}

module.exports = {
    isAuthenticated,
    isAdmin,
    isFabricManager,
    isCuttingManager,
    isStitchingMaster,
    isFinishingMaster,
    isWashingMaster,
    isJeansAssemblyMaster,
    isOperator,
    isSupervisor,
    isDepartmentUser,
    isAccountsAdmin,
    isPaymentAuthoriser,
    isWashingInMaster,
    isCatalogUpload,
    isStoreEmployee,
    isStoreAdmin,
    isIndentFiller,
    isStoreManager,
    isMohitOperator,
    isOnlyMohitOperator,
    isPOCreator,
    isNowiPOOrganization,
    isVendorFiles,
    isVideoFinder,
    isVideoCreator,
    isVmsOperator,
    isProductViewer,
    allowUserIds,
    allowRoles,
    allowUsernames
};
