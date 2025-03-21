// middlewares/auth.js 

// Middleware to check if the user is authenticated
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

function isDepartmentUser(req, res, next) {
    const departmentRoles = ['checking', 'quality_assurance'];
    if (req.session && req.session.user && departmentRoles.includes(req.session.user.roleName)) {
        return next();
    }
    req.flash('error', 'You do not have permission to view this page.');
    res.redirect('/');
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
    isDepartmentUser
};
