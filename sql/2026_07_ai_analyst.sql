-- Kotty Analyst (AI chat over production data) — conversation store + audit trail.
-- Every question, every answer, and every SQL the model ran (inside content JSON
-- for assistant turns) is kept here.
CREATE TABLE IF NOT EXISTS ai_chats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  username VARCHAR(100) NULL,
  title VARCHAR(120) NOT NULL DEFAULT 'New chat',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user (user_id, updated_at)
);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  chat_id INT NOT NULL,
  role ENUM('user','assistant') NOT NULL,
  content MEDIUMTEXT NOT NULL,          -- user: plain text; assistant: JSON {answer, steps, model}
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_chat (chat_id, id),
  CONSTRAINT fk_aicm_chat FOREIGN KEY (chat_id) REFERENCES ai_chats(id)
);
