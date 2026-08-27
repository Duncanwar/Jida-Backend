-- Every assignment that existed before the accept/decline flow was implicitly
-- accepted under the old model — a reviewer either did the review or the editor
-- unassigned them. Mark all current rows ACCEPTED so in-flight reviews are not
-- suddenly shown as "awaiting your response". Assignments created after this
-- migration default to PENDING via the application.
UPDATE "ReviewAssignment" SET "response" = 'ACCEPTED';
