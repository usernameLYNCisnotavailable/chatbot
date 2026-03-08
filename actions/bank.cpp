#include <iostream>
#include <string>
#include <fstream>
#include <sstream>
#include <vector>
#include <algorithm>
#include <winsock2.h>
#include <windows.h>
#include <cstdlib>
#include <ctime>

// ---- memory helpers ----
static std::string _memPath = "C:\\Users\\link\\Desktop\\learning\\chatcommander\\memory.json";

static std::string _getJsonField(const std::string& json, const std::string& key) {
    std::string search = "\"" + key + "\"";
    size_t pos = json.find(search);
    if (pos == std::string::npos) return "";
    pos = json.find(":", pos);
    if (pos == std::string::npos) return "";
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;
    if (json[pos] == '"') {
        pos++;
        std::string val;
        while (pos < json.size() && json[pos] != '"') {
            if (json[pos] == '\\') pos++;
            val += json[pos++];
        }
        return val;
    }
    std::string val;
    while (pos < json.size() && json[pos] != ',' && json[pos] != '}') val += json[pos++];
    while (!val.empty() && (val.back() == ' ' || val.back() == '\t')) val.pop_back();
    return val;
}

static std::string memGet(const std::string& key) {
    std::ifstream f(_memPath);
    if (!f.is_open()) return "";
    std::string json((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    f.close();
    return _getJsonField(json, key);
}

static void memSet(const std::string& key, const std::string& value) {
    std::string json = "{}";
    std::ifstream f(_memPath);
    if (f.is_open()) {
        json = std::string((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
        f.close();
    }
    std::string search = "\"" + key + "\"";
    size_t pos = json.find(search);
    if (pos != std::string::npos) {
        size_t end = json.find(',', pos);
        if (end == std::string::npos) {
            size_t prev = json.rfind(',', pos);
            if (prev != std::string::npos) pos = prev;
            json = json.substr(0, pos) + "\n}";
        } else {
            json = json.substr(0, pos) + json.substr(end + 1);
        }
    }
    std::string escaped;
    for (char c : value) {
        if (c == '"') escaped += "\\\"";
        else if (c == '\\') escaped += "\\\\";
        else escaped += c;
    }
    size_t closing = json.rfind('}');
    if (closing == std::string::npos) {
        json = "{\"" + key + "\": \"" + escaped + "\"}";
    } else {
        bool empty = json.substr(0, closing).find(':') == std::string::npos;
        if (empty) json = json.substr(0, closing) + "\"" + key + "\": \"" + escaped + "\"\n}";
        else json = json.substr(0, closing) + ",\n    \"" + key + "\": \"" + escaped + "\"\n}";
    }
    std::ofstream out(_memPath);
    out << json;
    out.close();
}
// ---- end memory helpers ----

int main(int argc, char* argv[]) {
    std::string username = argc > 1 ? argv[1] : "";
    std::string message  = argc > 2 ? argv[2] : "";
    std::string args     = argc > 3 ? argv[3] : "";
    std::string channel  = argc > 4 ? argv[4] : "";

    // --- YOUR CODE ---
#include <vector>
#include <algorithm>

// ---- HELPERS ----

auto sendToChat = [&](const std::string& msg) {
    WSADATA wsa;
    WSAStartup(MAKEWORD(2,2), &wsa);
    SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a;
    a.sin_family = AF_INET;
    a.sin_port = htons(9001);
    a.sin_addr.s_addr = inet_addr("127.0.0.1");
    connect(s, (sockaddr*)&a, sizeof(a));
    send(s, msg.c_str(), msg.size(), 0);
    closesocket(s);
    WSACleanup();
};

auto getBank = [&](const std::string& user) -> long long {
    std::string val = memGet("bank_" + user);
    if (val.empty()) { memSet("bank_" + user, "75"); return 75; }
    return std::stoll(val);
};
auto setBank = [&](const std::string& user, long long amount) {
    memSet("bank_" + user, std::to_string(amount));
};
auto getCash = [&](const std::string& user) -> long long {
    std::string val = memGet("cash_" + user);
    if (val.empty()) { memSet("cash_" + user, "25"); return 25; }
    return std::stoll(val);
};
auto setCash = [&](const std::string& user, long long amount) {
    memSet("cash_" + user, std::to_string(amount));
};
auto isJailed = [&](const std::string& user) -> bool {
    std::string jailEnd = memGet("jail_" + user);
    if (jailEnd.empty()) return false;
    return std::stoll(jailEnd) > (long long)time(nullptr);
};
auto jailTimeLeft = [&](const std::string& user) -> long long {
    std::string jailEnd = memGet("jail_" + user);
    if (jailEnd.empty()) return 0;
    long long diff = std::stoll(jailEnd) - (long long)time(nullptr);
    return diff > 0 ? diff : 0;
};
auto getAllUsers = [&]() -> std::vector<std::string> {
    std::vector<std::string> users;
    std::ifstream f(_memPath);
    if (!f.is_open()) return users;
    std::string line;
    while (std::getline(f, line)) {
        std::string prefix = "\"bank_";
        size_t pos = line.find(prefix);
        if (pos != std::string::npos) {
            pos += prefix.size();
            size_t end = line.find("\"", pos);
            if (end != std::string::npos)
                users.push_back(line.substr(pos, end - pos));
        }
    }
    f.close();
    return users;
};

// emoji shorthands (UTF-8)
// 🏦 = \xF0\x9F\x8F\xA6
// 💵 = \xF0\x9F\x92\xB5
// 🎁 = \xF0\x9F\x8E\x81
// 🦝 = \xF0\x9F\xA6\x9D
// 👮 = \xF0\x9F\x91\xAE
// 🏆 = \xF0\x9F\x8F\x86

// ---- PARSE ARGS ----
std::string sub = "";
std::string arg1 = "";
std::string arg2 = "";
std::istringstream argStream(args);
argStream >> sub >> arg1 >> arg2;
if (!arg1.empty() && arg1[0] == '@') arg1 = arg1.substr(1);

// ---- JAIL CHECK ----
if (sub != "leaderboard" && sub != "baltop" && sub != "balance" && sub != "bal" && sub != "admin") {
    if (isJailed(username)) {
        long long secs = jailTimeLeft(username);
        long long hrs = secs / 3600;
        long long mins = (secs % 3600) / 60;
        std::string t = hrs > 0 ? std::to_string(hrs) + "h " + std::to_string(mins) + "m" : std::to_string(mins) + "m";
        sendToChat("@" + username + " \xF0\x9F\x91\xAE Jail — locked up for " + t);
        return 0;
    }
}

// ---- BALANCE ----
if (sub == "balance" || sub == "bal") {
    std::string target = arg1.empty() ? username : arg1;
    long long bank = getBank(target);
    long long cash = getCash(target);
    sendToChat("@" + target + " \xF0\x9F\x8F\xA6 $" + std::to_string(bank) + " | \xF0\x9F\x92\xB5 $" + std::to_string(cash));
}

// ---- DEPOSIT ----
else if (sub == "deposit") {
    if (arg1.empty()) {
        sendToChat("@" + username + " usage: !bank deposit <amount> (max $50/hr)");
    } else {
        long long amount = std::stoll(arg1);
        if (amount <= 0 || amount > 50) {
            sendToChat("@" + username + " you can only deposit between $1 and $50 per hour.");
        } else {
            std::string lastKey = "deposit_time_" + username;
            std::string lastStr = memGet(lastKey);
            long long now = (long long)time(nullptr);
            if (!lastStr.empty() && (now - std::stoll(lastStr)) < 3600) {
                long long wait = 3600 - (now - std::stoll(lastStr));
                sendToChat("@" + username + " deposit again in " + std::to_string(wait / 60) + " minutes.");
            } else {
                long long cash = getCash(username);
                if (amount > cash) {
                    sendToChat("@" + username + " only have \xF0\x9F\x92\xB5 $" + std::to_string(cash));
                } else {
                    long long bank = getBank(username);
                    setCash(username, cash - amount);
                    setBank(username, bank + amount);
                    memSet(lastKey, std::to_string(now));
                    sendToChat("@" + username + " deposited $" + std::to_string(amount) + " \xF0\x9F\x8F\xA6 $" + std::to_string(bank + amount) + " | \xF0\x9F\x92\xB5 $" + std::to_string(cash - amount));
                }
            }
        }
    }
}

// ---- WITHDRAW ----
else if (sub == "withdraw") {
    if (arg1.empty()) {
        sendToChat("@" + username + " usage: !bank withdraw <amount>");
    } else {
        long long amount = std::stoll(arg1);
        long long bank = getBank(username);
        if (amount <= 0) {
            sendToChat("@" + username + " invalid amount.");
        } else if (amount > bank) {
            sendToChat("@" + username + " \xF0\x9F\x8F\xA6 only has $" + std::to_string(bank));
        } else {
            long long cash = getCash(username);
            setBank(username, bank - amount);
            setCash(username, cash + amount);
            sendToChat("@" + username + " withdrew $" + std::to_string(amount) + " \xF0\x9F\x8F\xA6 $" + std::to_string(bank - amount) + " | \xF0\x9F\x92\xB5 $" + std::to_string(cash + amount));
        }
    }
}

// ---- GIVE ----
else if (sub == "give") {
    if (arg1.empty() || arg2.empty()) {
        sendToChat("@" + username + " usage: !bank give @user <amount>");
    } else {
        long long amount = std::stoll(arg2);
        long long myBank = getBank(username);
        if (amount <= 0) {
            sendToChat("@" + username + " invalid amount.");
        } else if (amount > myBank) {
            sendToChat("@" + username + " \xF0\x9F\x8F\xA6 only has $" + std::to_string(myBank));
        } else {
            long long theirBank = getBank(arg1);
            setBank(username, myBank - amount);
            setBank(arg1, theirBank + amount);
            sendToChat("@" + username + " sent \xF0\x9F\x8F\xA6 $" + std::to_string(amount) + " to @" + arg1);
        }
    }
}

// ---- DAILY ----
else if (sub == "daily") {
    std::string lastKey = "daily_" + username;
    std::string lastStr = memGet(lastKey);
    long long now = (long long)time(nullptr);
    if (!lastStr.empty() && (now - std::stoll(lastStr)) < 86400) {
        long long wait = 86400 - (now - std::stoll(lastStr));
        long long hrs = wait / 3600;
        long long mins = (wait % 3600) / 60;
        sendToChat("@" + username + " \xF0\x9F\x8E\x81 come back in " + std::to_string(hrs) + "h " + std::to_string(mins) + "m");
    } else {
        long long bonus = 200;
        long long cash = getCash(username);
        setCash(username, cash + bonus);
        memSet(lastKey, std::to_string(now));
        sendToChat("@" + username + " \xF0\x9F\x8E\x81 +$" + std::to_string(bonus) + " \xF0\x9F\x92\xB5 $" + std::to_string(cash + bonus));
    }
}

// ---- ROB ----
else if (sub == "rob") {
    std::string coolKey = "rob_cooldown_" + username;
    std::string coolStr = memGet(coolKey);
    long long now = (long long)time(nullptr);
    if (!coolStr.empty() && (now - std::stoll(coolStr)) < 300) {
        long long wait = 300 - (now - std::stoll(coolStr));
        sendToChat("@" + username + " \xF0\x9F\xA6\x9D Rob — wait " + std::to_string(wait / 60 + 1) + " more minutes.");
    } else {
        long long myCash = getCash(username);
        std::string target = arg1;
        if (target.empty()) {
            std::vector<std::string> users = getAllUsers();
            users.erase(std::remove(users.begin(), users.end(), username), users.end());
            if (users.empty()) { sendToChat("@" + username + " nobody to rob!"); return 0; }
            srand((unsigned int)time(nullptr));
            target = users[rand() % users.size()];
        }
        long long theirCash = getCash(target);
        if (theirCash <= 0) {
            sendToChat("@" + username + " @" + target + " has no \xF0\x9F\x92\xB5 on them.");
        } else {
            long long amount = 0;
            if (!arg2.empty()) { amount = std::stoll(arg2); }
            else { amount = myCash / 10; if (amount < 1) amount = 1; }
            if (amount > theirCash) amount = theirCash;
            srand((unsigned int)time(nullptr));
            bool success = (rand() % 2) == 0;
            memSet(coolKey, std::to_string(now));
            if (success) {
                setCash(username, myCash + amount);
                setCash(target, theirCash - amount);
                sendToChat("@" + username + " \xF0\x9F\xA6\x9D Rob — stole \xF0\x9F\x92\xB5 $" + std::to_string(amount) + " from @" + target + "! \xF0\x9F\x92\xB5 $" + std::to_string(myCash + amount));
            } else {
                double ratio = myCash > 0 ? (double)amount / (double)myCash : 8.0;
                long long jailHours = (long long)(ratio * 2.0);
                if (jailHours < 1) jailHours = 1;
                if (jailHours > 8) jailHours = 8;
                memSet("jail_" + username, std::to_string(now + jailHours * 3600));
                sendToChat("@" + username + " \xF0\x9F\xA6\x9D Rob — caught stealing from @" + target + "! \xF0\x9F\x91\xAE Jail: " + std::to_string(jailHours) + "h");
            }
        }
    }
}

// ---- LEADERBOARD ----
else if (sub == "leaderboard" || sub == "baltop") {
    std::vector<std::string> users = getAllUsers();
    if (users.empty()) {
        sendToChat("No users yet!");
    } else {
        std::vector<std::pair<long long, std::string>> ranked;
        for (auto& u : users) {
            std::string bval = memGet("bank_" + u);
            std::string cval = memGet("cash_" + u);
            long long total = 0;
            if (!bval.empty()) total += std::stoll(bval);
            if (!cval.empty()) total += std::stoll(cval);
            ranked.push_back({total, u});
        }
        std::sort(ranked.begin(), ranked.end(), [](const std::pair<long long,std::string>& a, const std::pair<long long,std::string>& b) {
            return a.first > b.first;
        });
        std::string board = "\xF0\x9F\x8F\x86 ";
        int count = 0;
        for (auto& r : ranked) {
            if (count >= 5) break;
            board += std::to_string(count + 1) + ". @" + r.second + " $" + std::to_string(r.first) + " ";
            count++;
        }
        sendToChat(board);
    }
}

// ---- ADMIN ----
else if (sub == "admin") {
    if (username != channel) {
        sendToChat("@" + username + " no permission.");
    } else if (arg1 == "unjail" && !arg2.empty()) {
        std::string target = arg2;
        if (target[0] == '@') target = target.substr(1);
        memSet("jail_" + target, "0");
        sendToChat("@" + target + " \xF0\x9F\x91\xAE released!");
    } else if (arg1 == "resetcooldown" && !arg2.empty()) {
        std::string target = arg2;
        if (target[0] == '@') target = target.substr(1);
        memSet("rob_cooldown_" + target, "0");
        memSet("deposit_time_" + target, "0");
        memSet("daily_" + target, "0");
        sendToChat("@" + target + " cooldowns reset!");
    } else if (arg1 == "setbank") {
        std::istringstream reparse(args);
        std::string t1,t2,t3,t4;
        reparse >> t1 >> t2 >> t3 >> t4;
        if (!t3.empty() && t3[0] == '@') t3 = t3.substr(1);
        if (!t4.empty()) { setBank(t3, std::stoll(t4)); sendToChat("@" + t3 + " \xF0\x9F\x8F\xA6 $" + t4); }
        else sendToChat("Usage: !bank admin setbank @user <amount>");
    } else if (arg1 == "setcash") {
        std::istringstream reparse(args);
        std::string t1,t2,t3,t4;
        reparse >> t1 >> t2 >> t3 >> t4;
        if (!t3.empty() && t3[0] == '@') t3 = t3.substr(1);
        if (!t4.empty()) { setCash(t3, std::stoll(t4)); sendToChat("@" + t3 + " \xF0\x9F\x92\xB5 $" + t4); }
        else sendToChat("Usage: !bank admin setcash @user <amount>");
    } else {
        sendToChat("Admin: unjail @user | resetcooldown @user | setbank @user <amt> | setcash @user <amt>");
    }
}

// ---- HELP ----
else {
    sendToChat("@" + username + " \xF0\x9F\x8F\xA6 balance [@user] | deposit | withdraw | give @user | \xF0\x9F\x8E\x81 daily | \xF0\x9F\xA6\x9D rob [@user] | \xF0\x9F\x8F\x86 leaderboard");
}
    // --- END ---
    return 0;
}
