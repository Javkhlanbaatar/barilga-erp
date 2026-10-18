-- Until now every manager saw every warehouse. Keep that for the people who are managers today by making
-- them general managers; new branch managers (MANAGER) are limited to the warehouses they are given.
UPDATE "sys_users" SET "role" = 'SUPER_MANAGER' WHERE "role" = 'MANAGER';
