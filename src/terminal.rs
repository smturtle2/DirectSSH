pub struct TerminalBuffer {
    parser: vt100::Parser,
    rows: u16,
    cols: u16,
}

impl TerminalBuffer {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self {
            parser: vt100::Parser::new(rows, cols, 6000),
            rows,
            cols,
        }
    }

    pub fn reset(&mut self) {
        self.parser = vt100::Parser::new(self.rows, self.cols, 6000);
    }

    pub fn process(&mut self, data: &[u8]) {
        self.parser.process(data);
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.rows = rows.clamp(5, 200);
        self.cols = cols.clamp(20, 500);
        self.parser.screen_mut().set_size(self.rows, self.cols);
    }

    pub fn contents(&self) -> String {
        let mut text = self.parser.screen().contents();
        while text.ends_with('\n') || text.ends_with('\r') {
            text.pop();
        }
        if text.is_empty() {
            "DirectSSH terminal ready. Choose a saved session or add a profile.".to_string()
        } else {
            text
        }
    }
}
