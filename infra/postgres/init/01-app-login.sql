-- Local only: the login user the server connects as. Its privileges come from app_role,
-- which migration 0002 creates and grants. In production, create this user by hand with a
-- generated password and add it to app_role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicvoice_app') THEN
    CREATE ROLE clinicvoice_app LOGIN PASSWORD 'app_dev_password' IN ROLE app_role;
  END IF;
END
$$;
