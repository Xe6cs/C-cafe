-- Storage DELETE needs a matching SELECT policy.
--
-- Supabase Storage removes objects with `delete ... returning *`, so a role that
-- may DELETE a row in storage.objects must also be able to SELECT it. The public
-- bucket had upload/cleanup policies but no SELECT policy, which made every
-- admin cleanup of a staging/failed public copy fail with AccessDenied even when
-- the DELETE policy allowed it.
--
-- The read policy stays as narrow as the delete policy: admin only, public
-- bucket only, and only the exact registered object name of a staging or failed
-- row. Ready copies remain readable solely through the public object endpoint;
-- their metadata is never exposed by this policy.
--
-- This migration also drops the temporary policy used to verify the fix on the
-- remote project.

begin;

drop policy if exists ccafe_public_admin_read_tmp on storage.objects;

drop policy if exists ccafe_public_admin_read on storage.objects;
create policy ccafe_public_admin_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ccafe-public'
    and public.is_admin()
    and public.media_public_storage_path(storage.objects.name, array['staging', 'failed'])
  );

comment on policy ccafe_public_admin_read on storage.objects is
  'Allows an admin to select only staging/failed ccafe-public objects. Required because Supabase Storage DELETE performs DELETE ... RETURNING; ready copies are still readable only via the public endpoint.';

commit;
