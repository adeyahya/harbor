// The frontend build is embedded into the binary. Make sure the directory
// exists so the backend compiles before the frontend has been built.
fn main() {
    let dist = std::path::Path::new("../frontend/dist");
    if !dist.exists() {
        std::fs::create_dir_all(dist).expect("create frontend/dist");
    }
    println!("cargo:rerun-if-changed=../frontend/dist");
    println!("cargo:rerun-if-changed=migrations");
}
