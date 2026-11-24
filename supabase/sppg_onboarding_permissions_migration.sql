-- Restore server-only table privileges required by the SPPG onboarding Edge Function.
begin;

grant select, insert, update, delete on public.spas1_organizations to service_role;
grant select, insert, update, delete on public.spas1_memberships to service_role;
grant select, insert, update, delete on public.spas1_organization_requests to service_role;
grant select, insert, update, delete on public.spas1_organization_regions to service_role;

commit;
