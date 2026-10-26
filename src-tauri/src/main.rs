// Prevents an extra console window from opening alongside the app on Windows
// release builds. Debug builds keep it, which is where your `println!` output
// and Rust panic messages show up.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    veistra_orchestrator_lib::run()
}
